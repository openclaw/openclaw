import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { downloadClawHubPackageArchive } from "./clawhub-artifacts.js";
import * as packages from "./clawhub-packages.js";

function createResponseSource(params: { status: number; headersAfterMs?: number }) {
  const connected = createDeferred<{
    write: (bytes: Uint8Array) => void;
    close: () => void;
  }>();
  const aborted = vi.fn();
  const cancelled = vi.fn();
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("ClawHub fetch must supply its request signal");
    }
    if (params.headersAfterMs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, params.headersAfterMs);
      });
    }
    signal.throwIfAborted();
    const listenerLifetime = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => {
            aborted(signal.reason);
            listenerLifetime.abort();
            controller.error(signal.reason);
          },
          { once: true, signal: listenerLifetime.signal },
        );
        connected.resolve({
          write: (bytes) => controller.enqueue(bytes),
          close: () => {
            if (!listenerLifetime.signal.aborted) {
              listenerLifetime.abort();
              controller.close();
            }
          },
        });
      },
      cancel() {
        cancelled();
        listenerLifetime.abort();
      },
    });
    return new Response(body, {
      status: params.status,
      statusText: params.status === 400 ? "Bad Request" : undefined,
      headers: { "Retry-After": "0" },
    });
  };
  return { fetchImpl, connected: connected.promise, aborted, cancelled };
}

function observe<T>(operation: Promise<T>) {
  const settled = vi.fn();
  const result = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  void result.then(settled);
  return { result, settled };
}

async function pendingResponse<T>(
  params: Parameters<typeof createResponseSource>[0],
  run: () => Promise<T>,
  cleanup?: (value: T) => Promise<void>,
) {
  const source = createResponseSource(params);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(source.fetchImpl);
  const pending = observe(run());
  if (params.headersAfterMs) {
    await vi.advanceTimersByTimeAsync(params.headersAfterMs);
  }
  const body = await source.connected;
  return {
    source,
    pending,
    body,
    expectSettled() {
      expect(pending.settled).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
    async [Symbol.asyncDispose]() {
      body.close();
      const outcome = await pending.result;
      if ("value" in outcome) {
        await cleanup?.(outcome.value);
      }
    },
  };
}

describe("ClawHub response deadlines", () => {
  const request = {
    name: "deadline-fixture",
    query: "calendar",
    token: "fixture-token",
    timeoutMs: 100,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CLAWHUB_DISABLE_TELEMETRY", "0");
    vi.stubEnv("CLAWDHUB_DISABLE_TELEMETRY", "0");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ["detail", packages.fetchClawHubPackageDetail],
    ["list", packages.listClawHubPackages],
    ["version", packages.fetchClawHubPackageVersion],
    ["artifact", packages.fetchClawHubPackageArtifact],
    ["security", packages.fetchClawHubPackageSecurity],
    ["search", packages.searchClawHubPackages],
  ] as const)("cancels an outstanding package %s response", async (_name, read) => {
    const controller = new AbortController();
    await using fixture = await pendingResponse<unknown>({ status: 200 }, () =>
      read({
        name: "cancel-fixture",
        version: "1.0.0",
        query: "calendar",
        token: "fixture-token",
        signal: controller.signal,
      }),
    );
    controller.abort(new Error("Package read canceled"));
    await vi.advanceTimersByTimeAsync(0);
    fixture.expectSettled();
    await expect(fixture.pending.result).resolves.toEqual({ error: controller.signal.reason });
    expect(fixture.source.aborted).toHaveBeenCalledExactlyOnceWith(controller.signal.reason);
  });

  it.each([
    { kind: "metadata", status: 200, headersAfterMs: 60 },
    { kind: "metadata", status: 400, headersAfterMs: 60 },
    { kind: "archive", status: 400, headersAfterMs: 0 },
  ])("bounds a dripping $kind/$status body by its original deadline", async (scenario) => {
    await using fixture = await pendingResponse<unknown>(scenario, () =>
      scenario.kind === "archive"
        ? downloadClawHubPackageArchive(request)
        : packages.searchClawHubPackages(request),
    );
    const half = (100 - scenario.headersAfterMs) / 2;
    fixture.body.write(
      new TextEncoder().encode(scenario.kind === "archive" ? "partial error" : "partial"),
    );
    await vi.advanceTimersByTimeAsync(half);
    fixture.body.write(new TextEncoder().encode(" "));
    await vi.advanceTimersByTimeAsync(half - 1);
    expect(fixture.pending.settled).not.toHaveBeenCalled();
    fixture.body.write(new TextEncoder().encode(" "));
    await vi.advanceTimersByTimeAsync(1);
    fixture.expectSettled();
    const outcome = await fixture.pending.result;
    expect(outcome).toMatchObject({
      error:
        scenario.status === 200
          ? { message: "ClawHub request timed out after 100ms" }
          : { status: 400, responseBody: "Bad Request" },
    });
    if (scenario.kind === "metadata") {
      if (scenario.status === 400) {
        expect(outcome).toMatchObject({ error: { requestPath: "/api/v1/packages/search" } });
      }
      expect(fixture.source.cancelled).not.toHaveBeenCalled();
    }
    expect(fixture.source.aborted).toHaveBeenCalledOnce();
  });

  it("finishes a progressing successful archive after the absolute request budget", async () => {
    await using fixture = await pendingResponse(
      { status: 200 },
      () => downloadClawHubPackageArchive(request),
      (value) => value.cleanup(),
    );
    for (const byte of [1, 2, 3]) {
      fixture.body.write(new Uint8Array([byte]));
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(fixture.source.aborted).not.toHaveBeenCalled();
    expect(fixture.pending.settled).not.toHaveBeenCalled();
    fixture.body.write(new Uint8Array([4]));
    fixture.body.close();
    const outcome = await fixture.pending.result;
    expect(outcome).toHaveProperty("value");
    if ("value" in outcome) {
      await expect(fs.readFile(outcome.value.archivePath)).resolves.toEqual(
        Buffer.from([1, 2, 3, 4]),
      );
    }
    expect(fixture.source.cancelled).not.toHaveBeenCalled();
    fixture.expectSettled();
  });

  it("disposes the unread successful telemetry response", async () => {
    await using fixture = await pendingResponse({ status: 200 }, () =>
      packages.reportClawHubPluginInstallTelemetry({ ...request, packageName: request.name }),
    );
    await expect(fixture.pending.result).resolves.toEqual({ value: undefined });
    expect(fixture.source.cancelled).toHaveBeenCalledOnce();
    expect(fixture.source.aborted).not.toHaveBeenCalled();
    fixture.expectSettled();
  });

  it("releases a discarded retry response and the completed metadata deadline", async () => {
    const discarded = createResponseSource({ status: 503 });
    const successful = createResponseSource({ status: 200 });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(discarded.fetchImpl)
      .mockImplementationOnce(successful.fetchImpl);
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    const pending = observe(packages.searchClawHubPackages(request));
    const discardedBody = await discarded.connected;
    const successfulBody = await successful.connected;
    try {
      successfulBody.write(new TextEncoder().encode('{"results":[]}'));
      successfulBody.close();
      await expect(pending.result).resolves.toEqual({ value: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(discarded.cancelled).toHaveBeenCalledOnce();
      expect(discarded.aborted).not.toHaveBeenCalled();
      expect(successful.cancelled).not.toHaveBeenCalled();
      expect(successful.aborted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      discardedBody.close();
      successfulBody.close();
      await pending.result;
    }
  });
});
