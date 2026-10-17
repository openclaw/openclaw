import type { ServerResponse } from "node:http";
import type { Dispatcher } from "undici";
import { expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { createBoundedProviderBinaryStream } from "../../plugin-sdk/provider-binary-stream.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { captureHttpExchange } from "../../proxy-capture/runtime.js";
import type { CaptureEventRecord } from "../../proxy-capture/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readResponseTextPrefix, readResponseWithLimit } from "../http-body.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { wrapGuardedBodyStream } from "./guarded-body-stream.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";
import { fetchWithRuntimeDispatcher, type DispatcherAwareRequestInit } from "./runtime-fetch.js";

const withinDeadline = <T>(operation: Promise<T>) =>
  withTestTimeout(operation, 1_000, "guard release did not settle");

async function readText(response: Response, limit: number) {
  return (await readResponseWithLimit(response, limit)).toString("utf8");
}

it.each([
  { name: "Blob content type", init: {} },
  { name: "explicit content type", init: { headers: { "content-type": "application/json" } } },
  { name: "keepalive", init: { keepalive: true } },
  { name: "no-cors", init: { mode: "no-cors" as const } },
])("replays immutable request bytes across guarded redirects with $name", async ({ init }) => {
  const payload = '{"message":"retained 🦞 request"}';
  const body = new Blob([payload], { type: "text/plain" });
  const requests: Array<[string | undefined, string, string | undefined, string | undefined]> = [];
  let admissions = 0;
  await withServer(
    (request, response) => {
      let received = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        received += chunk;
      });
      request.on("end", () => {
        requests.push([
          request.url,
          received,
          request.headers["content-type"],
          request.headers["content-length"],
        ]);
        if (request.url === "/start") {
          response.writeHead(307, { location: "/complete" }).end();
        } else {
          response.end("complete");
        }
      });
    },
    async (baseUrl) => {
      const result = await fetchWithSsrFGuard({
        url: `${baseUrl}/start`,
        init: { method: "POST", body, ...init },
        policy: { allowPrivateNetwork: true },
        beforeRequest: () => {
          admissions++;
        },
      });
      try {
        expect(await readText(result.response, 32)).toBe("complete");
        expect(requests).toEqual(
          ["/start", "/complete"].map((path) => [
            path,
            payload,
            new Headers(init.headers).get("content-type") ?? body.type,
            String(Buffer.byteLength(payload)),
          ]),
        );
        expect(admissions).toBe(2);
        expect(await readText(new Response(body), body.size)).toBe(payload);
      } finally {
        await result.release();
      }
    },
  );
});

it.each(["unread", "prefix", "overflow", "wrapped", "binary"] as const)(
  "ends only the %s request while a captured sibling keeps its pooled transport",
  async (readerKind) => {
    const abandonedClosed = createDeferredCore();
    const heldResponse = createDeferredCore<ServerResponse>();
    const parent = new AbortController();
    const pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 60_000 });
    const dispatchers: Array<Dispatcher | undefined> = [];
    const captures = new Map<string, ReturnType<typeof createDeferredCore<CaptureEventRecord>>>();
    const expectCapture = async (path: string, dataText?: string) => {
      expect(await withinDeadline(captures.get(path)!.promise)).toMatchObject(
        dataText === undefined ? { kind: "error" } : { kind: "response", status: 200, dataText },
      );
    };
    const releases: Array<() => Promise<void>> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: DispatcherAwareRequestInit) => {
      dispatchers.push(init?.dispatcher);
      const url = input instanceof Request ? input.url : input.toString();
      const captured = createDeferredCore<CaptureEventRecord>();
      captures.set(new URL(url).pathname, captured);
      const response = await fetchWithRuntimeDispatcher(input, init);
      captureHttpExchange(
        { url, method: "GET", response, signal: init?.signal ?? undefined },
        {
          enabled: true,
          required: false,
          dbPath: "unused-memory-sink",
          blobDir: "unused-memory-sink",
          certDir: "unused-memory-sink",
          sessionId: "guard-release-test",
          sourceProcess: "test",
        },
        {
          getStore: () => ({
            upsertSession() {},
            endSession() {},
            recordEvent(event) {
              if (event.kind === "response" || event.kind === "error") {
                captured.resolve(event);
              }
            },
          }),
          persistEventPayload: (_store, { data }) =>
            Buffer.isBuffer(data) ? { dataText: data.toString("utf8") } : {},
        },
      );
      return response;
    };

    await withServer(
      (request, response) => {
        if (request.url === "/abandoned") {
          request.socket.once("close", () => abandonedClosed.resolve());
          response.writeHead(503);
          response.write("unused error body");
        } else if (request.url === "/held") {
          response.write("kept");
          heldResponse.resolve(response);
        } else {
          response.end("complete");
        }
      },
      async (baseUrl) => {
        let heldBody: Promise<Buffer> | undefined;
        let abandonedOperation: Promise<void> | undefined;
        const get = async (path: string) => {
          const result = await fetchWithSsrFGuard({
            url: `${baseUrl}${path}`,
            fetchImpl,
            signal: parent.signal,
            timeoutMs: 5_000,
            policy: { allowPrivateNetwork: true, hostnameAllowlist: ["127.0.0.1"] },
            dispatcherPool: pool,
          });
          releases.push(result.release);
          return result;
        };
        try {
          const abandoned = await get("/abandoned");
          const held = await get("/held");
          heldBody = readResponseWithLimit(held.response, 32);
          void heldBody.catch(() => undefined);
          expect(abandoned.response.status).toBe(503);
          expect(held.dispatcherReused).toBe(true);
          expect(dispatchers[0]).toBeDefined();
          expect(dispatchers[1]).toBe(dispatchers[0]);

          abandonedOperation = (async () => {
            const reason = new Error("body limit reached");
            if (readerKind === "wrapped") {
              const wrapped = wrapGuardedBodyStream({
                body: abandoned.response.body!,
                cleanup: abandoned.release,
              });
              const reader = wrapped.getReader();
              try {
                expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
                await reader.cancel(reason);
              } finally {
                reader.releaseLock();
              }
              return;
            }
            try {
              if (readerKind === "prefix") {
                expect(await readResponseTextPrefix(abandoned.response, 4)).toMatchObject({
                  text: "unus",
                  truncated: true,
                });
              } else if (readerKind === "overflow") {
                await expect(
                  readResponseWithLimit(abandoned.response, 4, {
                    onOverflow: () => reason,
                  }),
                ).rejects.toBe(reason);
              } else if (readerKind === "binary") {
                const bounded = createBoundedProviderBinaryStream(abandoned.response.body!, {
                  maxBytes: 4,
                  createOverflowError: () => reason,
                  createReleaseError: () => reason,
                  cleanup: abandoned.release,
                });
                const reader = bounded.stream.getReader();
                try {
                  const chunks: Uint8Array[] = [];
                  await expect(
                    (async () => {
                      for (
                        let chunk = await reader.read();
                        !chunk.done;
                        chunk = await reader.read()
                      ) {
                        chunks.push(chunk.value);
                      }
                    })(),
                  ).rejects.toBe(reason);
                  expect(Buffer.concat(chunks).toString()).toBe("unus");
                } finally {
                  reader.releaseLock();
                  await bounded.release();
                }
              }
            } finally {
              await abandoned.release();
            }
          })();
          await withinDeadline(abandonedOperation.then(() => abandonedClosed.promise));
          expect(parent.signal.aborted).toBe(false);
          await expectCapture("/abandoned");

          (await heldResponse.promise).end("-alive");
          expect((await withinDeadline(heldBody)).toString("utf8")).toBe("kept-alive");
          await held.release();
          await expectCapture("/held", "kept-alive");

          const completed = await get("/complete");
          expect(completed.dispatcherReused).toBe(true);
          expect(dispatchers[2]).toBe(dispatchers[0]);
          const completedClone = completed.response.clone();
          expect(completedClone.url).toBe(completed.response.url);
          expect(completedClone.redirected).toBe(completed.response.redirected);
          expect(completedClone.type).toBe(completed.response.type);
          expect(() => completed.response.headers.set("x-openclaw-test", "1")).toThrow();
          expect(() => completedClone.headers.set("x-openclaw-test", "1")).toThrow();
          expect(
            await Promise.all([readText(completed.response, 32), readText(completedClone, 32)]),
          ).toEqual(["complete", "complete"]);
          await completed.release();
          await expectCapture("/complete", "complete");
          expect(parent.signal.aborted).toBe(false);
        } finally {
          parent.abort();
          await abandonedOperation?.catch(() => undefined);
          await heldBody?.catch(() => undefined);
          await Promise.all(releases.map((release) => release()));
          await pool.closeAll();
        }
      },
    );
  },
);

it.each([false, true])("preserves caller cancellation (explicit signal: %s)", async (explicit) => {
  const parent = new AbortController();
  const ignored = new AbortController();
  const reason = new Error("caller stopped");
  await withServer(
    (_request, response) => response.write("unfinished"),
    async (baseUrl) => {
      const result = await fetchWithSsrFGuard({
        url: baseUrl,
        ...(explicit ? { signal: parent.signal, timeoutMs: 5_000 } : {}),
        init: { signal: explicit ? ignored.signal : parent.signal },
        policy: { allowPrivateNetwork: true },
      });
      const body = readResponseWithLimit(result.response, 32);
      try {
        if (explicit) {
          ignored.abort(new Error("ignored init signal"));
        }
        parent.abort(reason);
        await expect(withinDeadline(body)).rejects.toBe(reason);
        await result.release();
        expect(parent.signal.reason).toBe(reason);
      } finally {
        parent.abort();
        await result.release();
      }
    },
  );
});
