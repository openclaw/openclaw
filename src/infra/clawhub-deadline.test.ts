import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { downloadClawHubPackageArchive } from "./clawhub-artifacts.js";
import type { ClawHubFetch } from "./clawhub-client.js";
import { reportClawHubPluginInstallTelemetry, searchClawHubPackages } from "./clawhub-packages.js";

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

type ResponseSource = ReturnType<typeof createResponseSource>;
async function withResponse<T>(
  sources: ResponseSource[],
  operation: Promise<T>,
  check: (
    bodies: Awaited<ResponseSource["connected"]>[],
    pending: ReturnType<typeof observe<T>>,
  ) => Promise<void>,
  cleanup?: (value: T) => Promise<void>,
  headersAfterMs = 0,
) {
  const pending = observe(operation);
  if (headersAfterMs) {
    await vi.advanceTimersByTimeAsync(headersAfterMs);
  }
  const bodies = [];
  for (const source of sources) {
    bodies.push(await source.connected);
  }
  try {
    await check(bodies, pending);
  } finally {
    for (const body of bodies) {
      body.close();
    }
    const outcome = await pending.result;
    if ("value" in outcome) {
      await cleanup?.(outcome.value);
    }
  }
}

const options = { token: "fixture-token", timeoutMs: 100 };
const search = (fetchImpl: ClawHubFetch) =>
  searchClawHubPackages({ ...options, query: "calendar", fetchImpl });
const download = (fetchImpl: ClawHubFetch) =>
  downloadClawHubPackageArchive({ ...options, name: "deadline-fixture", fetchImpl });
const encode = (value: string) => new TextEncoder().encode(value);

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
    ["metadata", 200, 60, 20, { message: "ClawHub request timed out after 100ms" }],
    [
      "metadata",
      400,
      60,
      20,
      { status: 400, requestPath: "/api/v1/packages/search", responseBody: "Bad Request" },
    ],
    ["archive", 400, 0, 50, { status: 400, responseBody: "Bad Request" }],
  ] as const)(
    "keeps the absolute deadline through a dripping %s %s body",
    async (kind, status, headersAfterMs, dripAfterMs, error) => {
      const source = createResponseSource({ status, headersAfterMs });
      await withResponse<Awaited<ReturnType<typeof search | typeof download>>>(
        [source],
        kind === "metadata" ? search(source.fetchImpl) : download(source.fetchImpl),
        async ([body], pending) => {
          body.write(encode(kind === "metadata" ? "partial" : "partial error"));
          await vi.advanceTimersByTimeAsync(dripAfterMs);
          body.write(encode(" "));
          await vi.advanceTimersByTimeAsync(99 - headersAfterMs - dripAfterMs);
          expect(pending.settled).not.toHaveBeenCalled();
          if (kind === "metadata") {
            body.write(encode(" "));
          }
          await vi.advanceTimersByTimeAsync(1);
          expect(pending.settled).toHaveBeenCalledOnce();
          await expect(pending.result).resolves.toMatchObject({ error });
          expect(source.aborted).toHaveBeenCalledOnce();
          if (kind === "metadata") {
            expect(source.cancelled).not.toHaveBeenCalled();
          }
          expect(vi.getTimerCount()).toBe(0);
        },
        undefined,
        headersAfterMs,
      );
    },
  );

  it("finishes a progressing successful archive after the absolute request budget", async () => {
    const source = createResponseSource({ status: 200 });
    await withResponse(
      [source],
      download(source.fetchImpl),
      async ([body], pending) => {
        for (const byte of [1, 2, 3]) {
          body.write(new Uint8Array([byte]));
          await vi.advanceTimersByTimeAsync(40);
        }
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
      },
      (value) => value.cleanup(),
    );
  });

  it("disposes the unread successful telemetry response", async () => {
    const source = createResponseSource({ status: 200 });
    const operation = reportClawHubPluginInstallTelemetry({
      ...options,
      packageName: "deadline-fixture",
      fetchImpl: source.fetchImpl,
    });
    await withResponse([source], operation, async (_bodies, pending) => {
      await expect(pending.result).resolves.toEqual({ value: undefined });
      expect(source.cancelled).toHaveBeenCalledOnce();
      expect(source.aborted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("releases a discarded retry response and the completed metadata deadline", async () => {
    const discarded = createResponseSource({ status: 503 });
    const successful = createResponseSource({ status: 200 });
    const fetchImpl = vi
      .fn<ClawHubFetch>()
      .mockImplementationOnce(discarded.fetchImpl)
      .mockImplementationOnce(successful.fetchImpl);
    await withResponse([discarded, successful], search(fetchImpl), async ([, body], pending) => {
      body.write(encode('{"results":[]}'));
      body.close();
      await expect(pending.result).resolves.toEqual({ value: [] });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(discarded.cancelled).toHaveBeenCalledOnce();
      expect(discarded.aborted).not.toHaveBeenCalled();
      expect(successful.cancelled).not.toHaveBeenCalled();
      expect(successful.aborted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
