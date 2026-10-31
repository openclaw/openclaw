// Count across replacement clients: an old request can settle after its successor starts.
let pendingForegroundRequests = 0;
export function reportPendingForegroundActivity(registration: ServiceWorkerRegistration): void {
  for (const worker of [registration.installing, registration.waiting, registration.active]) {
    try {
      worker?.postMessage(
        { type: "openclaw-foreground-activity", active: pendingForegroundRequests > 0 },
        [],
      );
    } catch {
      // A retired worker need not receive this optional bandwidth hint.
    }
  }
}

function reportForegroundActivity(change: 1 | -1): void {
  pendingForegroundRequests += change;
  if (
    (change === 1 ? pendingForegroundRequests !== 1 : pendingForegroundRequests !== 0) ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }
  // Installation fills the offline cache before there is a controlling worker.
  void navigator.serviceWorker
    .getRegistration()
    .then((registration) => {
      if (registration) {
        reportPendingForegroundActivity(registration);
      }
    })
    .catch(() => {}); // Optional offline caching never owns request success.
}

export function trackForegroundActivity<T>(request: Promise<T>): Promise<T> {
  reportForegroundActivity(1);
  return request.finally(() => reportForegroundActivity(-1));
}
