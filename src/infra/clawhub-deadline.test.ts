import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { downloadClawHubPackageArchive } from "./clawhub-artifacts.js";
import type { ClawHubFetch } from "./clawhub-client.js";
import { reportClawHubPluginInstallTelemetry, searchClawHubPackages } from "./clawhub-packages.js";
import { reportClawHubSkillInstallTelemetry } from "./clawhub-skills.js";

function createResponseSource(params: { status: number; headersAfterMs?: number }) {
  const connected = createDeferred<{
    write: (bytes: Uint8Array) => void;
    close: () => void;
  }>();
  const aborted = vi.fn();
  const cancelled = vi.fn();
  const fetchImpl: ClawHubFetch = async (_input, init) => {
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
    let ended = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => {
            ended = true;
            aborted(signal.reason);
            listenerLifetime.abort();
            controller.error(signal.reason);
          },
          { once: true, signal: listenerLifetime.signal },
        );
        connected.resolve({
          write: (bytes) => controller.enqueue(bytes),
          close: () => {
            if (!ended) {
              ended = true;
              listenerLifetime.abort();
              controller.close();
            }
          },
        });
      },
      cancel() {
        ended = true;
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

describe("ClawHub response deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CLAWHUB_DISABLE_TELEMETRY", "0");
    vi.stubEnv("CLAWDHUB_DISABLE_TELEMETRY", "0");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      status: 200,
      expectedError: { message: "ClawHub request timed out after 100ms" },
    },
    {
      status: 400,
      expectedError: {
        status: 400,
        requestPath: "/api/v1/packages/search",
        responseBody: "Bad Request",
      },
    },
  ])("keeps the original deadline through a dripping $status metadata body", async (scenario) => {
    const source = createResponseSource({ status: scenario.status, headersAfterMs: 60 });
    const pending = observe(
      searchClawHubPackages({
        query: "calendar",
        token: "fixture-token",
        timeoutMs: 100,
        fetchImpl: source.fetchImpl,
      }),
    );
    await vi.advanceTimersByTimeAsync(60);
    const body = await source.connected;
    try {
      body.write(new TextEncoder().encode("partial"));
      await vi.advanceTimersByTimeAsync(20);
      body.write(new TextEncoder().encode(" "));
      await vi.advanceTimersByTimeAsync(19);
      expect(pending.settled).not.toHaveBeenCalled();
      body.write(new TextEncoder().encode(" "));
      await vi.advanceTimersByTimeAsync(1);

      expect(pending.settled).toHaveBeenCalledOnce();
      await expect(pending.result).resolves.toMatchObject({ error: scenario.expectedError });
      expect(source.aborted).toHaveBeenCalledOnce();
      expect(source.cancelled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.close();
      await pending.result;
    }
  });

  it("keeps a dripping archive error under the absolute deadline", async () => {
    const source = createResponseSource({ status: 400 });
    const pending = observe(
      downloadClawHubPackageArchive({
        name: "deadline-fixture",
        token: "fixture-token",
        timeoutMs: 100,
        fetchImpl: source.fetchImpl,
      }),
    );
    const body = await source.connected;
    try {
      body.write(new TextEncoder().encode("partial error"));
      await vi.advanceTimersByTimeAsync(50);
      body.write(new TextEncoder().encode(" "));
      await vi.advanceTimersByTimeAsync(49);
      expect(pending.settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(pending.settled).toHaveBeenCalledOnce();
      await expect(pending.result).resolves.toMatchObject({
        error: { status: 400, responseBody: "Bad Request" },
      });
      expect(source.aborted).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.close();
      await pending.result;
    }
  });

  it("finishes a progressing successful archive after the absolute request budget", async () => {
    const source = createResponseSource({ status: 200 });
    const pending = observe(
      downloadClawHubPackageArchive({
        name: "deadline-fixture",
        token: "fixture-token",
        timeoutMs: 100,
        fetchImpl: source.fetchImpl,
      }),
    );
    const body = await source.connected;
    try {
      body.write(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(40);
      body.write(new Uint8Array([2]));
      await vi.advanceTimersByTimeAsync(40);
      body.write(new Uint8Array([3]));
      await vi.advanceTimersByTimeAsync(40);
      expect(source.aborted).not.toHaveBeenCalled();
      expect(pending.settled).not.toHaveBeenCalled();
      body.write(new Uint8Array([4]));
      body.close();

      const outcome = await pending.result;
      expect(outcome).toHaveProperty("value");
      if ("value" in outcome) {
        await expect(fs.readFile(outcome.value.archivePath)).resolves.toEqual(
          Buffer.from([1, 2, 3, 4]),
        );
      }
      expect(source.cancelled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.close();
      const outcome = await pending.result;
      if ("value" in outcome) {
        await outcome.value.cleanup();
      }
    }
  });

  it.each([
    {
      name: "plugin",
      report: (fetchImpl: ClawHubFetch) =>
        reportClawHubPluginInstallTelemetry({
          packageName: "deadline-fixture",
          token: "fixture-token",
          timeoutMs: 100,
          fetchImpl,
        }),
    },
    {
      name: "skill",
      report: (fetchImpl: ClawHubFetch) =>
        reportClawHubSkillInstallTelemetry({
          slug: "deadline-fixture",
          token: "fixture-token",
          timeoutMs: 100,
          fetchImpl,
        }),
    },
  ])("disposes the unread successful $name telemetry response", async ({ report }) => {
    const source = createResponseSource({ status: 200 });
    const pending = observe(report(source.fetchImpl));
    const body = await source.connected;
    try {
      await expect(pending.result).resolves.toEqual({ value: undefined });
      expect(source.cancelled).toHaveBeenCalledOnce();
      expect(source.aborted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.close();
      await pending.result;
    }
  });

  it("releases a discarded retry response and the completed metadata deadline", async () => {
    const discarded = createResponseSource({ status: 503 });
    const successful = createResponseSource({ status: 200 });
    const fetchImpl = vi
      .fn<ClawHubFetch>()
      .mockImplementationOnce(discarded.fetchImpl)
      .mockImplementationOnce(successful.fetchImpl);
    const pending = observe(
      searchClawHubPackages({
        query: "calendar",
        token: "fixture-token",
        timeoutMs: 100,
        fetchImpl,
      }),
    );
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
