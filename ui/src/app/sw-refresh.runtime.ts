import { controlUiWorkerActivationRetires } from "../build-info.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

function waitForReplacementWorker(worker: ServiceWorker): Promise<void> {
  if (worker.state === "activated" || worker.state === "redundant") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") {
        return;
      }
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

async function readWorkerBuild(worker: ServiceWorker): Promise<unknown> {
  const channel = new MessageChannel();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<unknown>((resolve) => {
      // Older workers do not answer probes. Bound the wait and release both
      // ports so an unavailable worker cannot strand terminal reconnect work.
      timeout = setTimeout(() => resolve(null), 1_000);
      channel.port1.addEventListener("message", (event) => resolve(event.data), { once: true });
      channel.port1.start();
      worker.postMessage({ type: "sw-version-probe" }, [channel.port2]);
    });
  } finally {
    clearTimeout(timeout);
    channel.port1.close();
    channel.port2.close();
  }
}

async function reconcileActiveWorker(registration: ServiceWorkerRegistration): Promise<boolean> {
  const worker = registration.active;
  if (!worker) {
    return false;
  }
  const message = await readWorkerBuild(worker);
  // Activation or foreground recovery picks up a replacement after this query.
  if (registration.active !== worker || !controlUiWorkerActivationRetires(message)) {
    return false;
  }
  // A worker must not supersede a target established by the Gateway handshake.
  return scheduleStaleChunkReload({
    canReload: () => registration.active === worker,
  });
}

/** Returns true only when recovery actually admitted a document reload. */
export async function refreshControlUiServiceWorker(): Promise<boolean> {
  const serviceWorker =
    typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : null;
  if (!serviceWorker) {
    return false;
  }
  const registration = await serviceWorker.getRegistration();
  if (!registration) {
    return false;
  }
  // A freshly loaded document can already be newer than the active worker.
  // Let its installing replacement settle before comparing build identities.
  let replacement = registration.installing ?? registration.waiting;
  if (!replacement) {
    try {
      await registration.update();
    } catch (error) {
      // A failed update check must not hide a replacement that already activated
      // while the page slept. Preserve the failure unless recovery can proceed.
      if (await reconcileActiveWorker(registration)) {
        return true;
      }
      throw error;
    }
    replacement = registration.installing ?? registration.waiting;
  }
  if (replacement) {
    await waitForReplacementWorker(replacement);
  }
  // Query even when no update was discovered: activation may be long finished.
  return reconcileActiveWorker(registration);
}
