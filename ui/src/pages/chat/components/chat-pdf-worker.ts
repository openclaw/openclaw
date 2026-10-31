import { inferControlUiPublicAssetPath } from "../../../app/public-assets.ts";
import { listen } from "../../../lib/reactive/listener.ts";

const WORKER_TIMEOUT_MS = 10_000;
const DISPOSE_TIMEOUT_MS = 1_000;

/** One reader owns one worker; only the latest pending bytes can become visible. */
export function createPdfPreviewWorker(onUrl: (url: string) => void, onError: () => void) {
  const worker = new Worker(inferControlUiPublicAssetPath("pdf-preview-worker.js"));
  let ready = false;
  let disposed = false;
  let generation = 0;
  let inFlight: number | undefined;
  let pending: { generation: number; bytes: ArrayBuffer } | undefined;
  let timer: ReturnType<typeof setTimeout>;

  const finish = () => {
    clearTimeout(timer);
    for (const stop of listeners) {
      stop();
    }
  };
  const terminate = () => {
    finish();
    worker.terminate();
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    pending = undefined;
    clearTimeout(timer);
    // Let the creator revoke explicitly before terminating; a hung worker is bounded.
    timer = setTimeout(terminate, DISPOSE_TIMEOUT_MS);
    try {
      worker.postMessage({ type: "dispose" }, []);
    } catch {
      terminate();
    }
  };
  const fail = () => {
    if (disposed) {
      return;
    }
    dispose();
    onError();
  };
  const send = () => {
    if (!ready || inFlight !== undefined || !pending || disposed) {
      return;
    }
    const next = pending;
    pending = undefined;
    inFlight = next.generation;
    try {
      // Never transfer: the read memo still owns these bytes for exact equality.
      worker.postMessage({ type: "show", ...next }, []);
    } catch {
      fail();
    }
  };
  timer = setTimeout(fail, WORKER_TIMEOUT_MS);
  const receive = ({ data }: MessageEvent<unknown>) => {
    if (disposed) {
      if (data && typeof data === "object" && "type" in data && data.type === "disposed") {
        finish();
      }
      return;
    }
    if (!data || typeof data !== "object" || !("type" in data)) {
      fail();
      return;
    }
    if (data.type === "ready" && !ready) {
      ready = true;
      clearTimeout(timer);
      if (pending) {
        timer = setTimeout(fail, WORKER_TIMEOUT_MS);
      }
      send();
      return;
    }
    if (!("generation" in data) || !Number.isSafeInteger(data.generation)) {
      fail();
      return;
    }
    if (data.generation !== inFlight) {
      return;
    }
    inFlight = undefined;
    if (data.generation !== generation) {
      send();
      return;
    }
    if (
      data.type !== "shown" ||
      !("url" in data) ||
      typeof data.url !== "string" ||
      !data.url.startsWith("blob:" + location.origin + "/")
    ) {
      fail();
      return;
    }
    clearTimeout(timer);
    onUrl(data.url);
  };
  const listeners = [
    listen(worker, "message", receive),
    listen(worker, "error", fail),
    listen(worker, "messageerror", fail),
  ];
  return {
    show(bytes: ArrayBuffer) {
      if (disposed) {
        return;
      }
      pending = { generation: ++generation, bytes };
      if (ready) {
        clearTimeout(timer);
        timer = setTimeout(fail, WORKER_TIMEOUT_MS);
      }
      send();
    },
    dispose,
  };
}
