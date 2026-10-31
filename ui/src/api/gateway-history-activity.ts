// Count across replacement clients: an old request can settle after its successor starts.
let pendingHistoryRequests = 0;
export function reportPendingHistoryActivity(registration: ServiceWorkerRegistration): void {
  for (const worker of [registration.installing, registration.waiting, registration.active]) {
    try {
      worker?.postMessage(
        { type: "openclaw-history-activity", active: pendingHistoryRequests > 0 },
        [],
      );
    } catch {
      // A retired worker need not receive this optional bandwidth hint.
    }
  }
}

function reportHistoryActivity(change: 1 | -1): void {
  pendingHistoryRequests += change;
  if (
    (change === 1 ? pendingHistoryRequests !== 1 : pendingHistoryRequests !== 0) ||
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
        reportPendingHistoryActivity(registration);
      }
    })
    .catch(() => {}); // Optional offline caching never owns request success.
}

export function trackHistoryActivity<T>(method: string, request: Promise<T>): Promise<T> {
  if (!["chat.history", "chat.startup", "sessions.messages.subscribe"].includes(method)) {
    return request;
  }
  reportHistoryActivity(1);
  return request.finally(() => reportHistoryActivity(-1));
}
