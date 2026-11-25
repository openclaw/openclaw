import { request } from "node:http";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { encodeDebugProxyPayload } from "./cli-contract.js";
import { readDebugProxyChildEndpoint, type DebugProxySettings } from "./env.js";
import { finalizeCaptureStoreAsync } from "./store-lifecycle.js";
import type { AsyncDebugProxyCaptureWriter } from "./store.types.js";

export const DEBUG_PROXY_CHILD_CAPTURE_PATH = "/.openclaw/debug-proxy-capture";

/** A child forwards only its capture writes to the parent's already-selected state owner. */
export function createDebugProxyChildCaptureStore(settings: DebugProxySettings) {
  const credentials = readDebugProxyChildEndpoint();
  if (!credentials) {
    return undefined;
  }
  const token = decodeURIComponent(credentials.password);
  if (!token) {
    throw new Error(
      "Parent debug proxy capture credentials are missing or invalid; no local fallback was attempted",
    );
  }
  if (!settings.proxyUrl) {
    throw new Error("Debug proxy child capture requires its parent proxy URL");
  }
  const endpoint = new URL(DEBUG_PROXY_CHILD_CAPTURE_PATH, settings.proxyUrl);
  if (endpoint.protocol !== "http:") {
    throw new Error("Debug proxy child capture requires an HTTP parent listener");
  }
  registerSecretValueForRedaction(token);
  let closed = false;
  let closing = false;
  let completion: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const send = (command: object): Promise<void> => {
    const body = JSON.stringify(command);
    const operation = queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = request(
            endpoint,
            {
              method: "POST",
              agent: false,
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
            },
            (res) => {
              res.resume();
              res.once("error", reject);
              res.once("end", () =>
                res.statusCode === 204
                  ? resolve()
                  : reject(
                      new Error(`Parent debug proxy refused capture (HTTP ${res.statusCode})`),
                    ),
              );
            },
          );
          req.once("error", reject);
          req.setTimeout(600_000, () =>
            req.destroy(
              new Error("Parent debug proxy capture outcome is unknown; no retry was attempted"),
            ),
          );
          req.end(body);
        }),
    );
    queue = operation.catch(() => undefined);
    return operation;
  };
  const writer = (assertCurrent: () => void): AsyncDebugProxyCaptureWriter => {
    const execute = (command: object) => {
      assertCurrent();
      return send(command);
    };
    return {
      get isClosed() {
        return closed;
      },
      upsertSession: (input) => execute({ type: "capture.upsertSession", input }),
      endSession: (sessionId, endedAt = Date.now()) =>
        execute({ type: "capture.endSession", input: { sessionId, endedAt } }),
      recordEvent: (input) => execute({ type: "capture.recordEvent", input }),
      recordEventWithPayload: (event, payload) =>
        execute({
          type: "capture.recordEventWithPayload",
          input: { event, payload: encodeDebugProxyPayload(payload) },
        }),
      close: () => {
        closing = true;
        completion ??= (async () => {
          try {
            await finalizeCaptureStoreAsync(
              store,
              writer(() => {
                if (closed) {
                  throw new Error("Debug proxy child capture is closed");
                }
              }),
            );
          } finally {
            await queue;
            closed = true;
          }
        })();
        return completion;
      },
    };
  };
  const assertOpen = () => {
    if (closed || closing) {
      throw new Error("Debug proxy child capture is closed");
    }
  };
  const store = writer(assertOpen);
  return {
    store,
    ready: Promise.resolve(),
    release: () => store.close(),
    async runOperation<T>(operation: (store: AsyncDebugProxyCaptureWriter) => Promise<T>) {
      assertOpen();
      let active = true;
      try {
        return await operation(
          writer(() => {
            if (!active || closed) {
              throw new Error("Debug proxy child capture operation has settled");
            }
          }),
        );
      } finally {
        active = false;
      }
    },
  };
}
