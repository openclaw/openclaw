/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker ports have no browser target origin. */
import { getCACertificates } from "node:tls";
import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("System CA warmup requires a worker thread");
}

try {
  getCACertificates("default");
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  parentPort.close();
}
