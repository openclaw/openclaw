import { raceWithTimeout } from "@openclaw/retry";
import { controlUiWorkerActivationRetires } from "../build-info.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

function waitForReplacementWorker(worker: ServiceWorker): Promise<boolean> {
  if (worker.state === "activated" || worker.state === "redundant") {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") {
        return;
      }
      finish(true);
    };
    const finish = (settled: boolean) => {
      clearTimeout(timeout);
      worker.removeEventListener("statechange", onStateChange);
      resolve(settled);
    };
    const timeout = setTimeout(() => finish(false), 10_000);
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

async function reconcileActiveWorker(
  registration: ServiceWorkerRegistration,
  isCurrent: () => boolean,
): Promise<boolean> {
  const worker = registration.active;
  if (!worker || !isCurrent()) {
    return false;
  }
  const message = await readWorkerBuild(worker);
  // Activation or foreground recovery picks up a replacement after this query.
  if (
    !isCurrent() ||
    registration.active !== worker ||
    !controlUiWorkerActivationRetires(message)
  ) {
    return false;
  }
  // A worker must not supersede a target established by the Gateway handshake.
  return scheduleStaleChunkReload({
    canReload: () => isCurrent() && registration.active === worker,
  });
}

/** Returns true only when recovery actually admitted a document reload. */
export async function refreshControlUiServiceWorker(): Promise<boolean> {
  let current = true;
  try {
    return await raceWithTimeout(
      () => refresh(() => current),
      10_000,
      () => false,
    );
  } finally {
    current = false;
  }
}

async function refresh(isCurrent: () => boolean): Promise<boolean> {
  const serviceWorker =
    typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : null;
  if (!serviceWorker) {
    return false;
  }
  const registration = await serviceWorker.getRegistration();
  if (!registration || !isCurrent()) {
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
      if (await reconcileActiveWorker(registration, isCurrent)) {
        return true;
      }
      throw error;
    }
    replacement = registration.installing ?? registration.waiting;
  }
  if (!isCurrent()) {
    return false;
  }
  if (replacement && !(await waitForReplacementWorker(replacement))) {
    return false;
  }
  // Query even when no update was discovered: activation may be long finished.
  return reconcileActiveWorker(registration, isCurrent);
}
