import type { ApplicationGateway } from "./gateway.ts";

const REPORT_INTERVAL_MS = 30_000;
const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;
// Document lifetime, not socket lifetime: tab recovery must not look like a new visit.
const visitedDocuments = new WeakSet<Document>();

/** Reports interaction without sampling input content or treating liveness as activity. */
export function startGatewayPresenceActivity(
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">,
  documentTarget: Document,
): () => void {
  let disposed = false;
  let lastReportedAt = -Infinity;
  let pending = false;
  const report = () => {
    const { client, phase } = gateway.snapshot;
    if (
      disposed ||
      pending ||
      !client ||
      phase !== "connected" ||
      documentTarget.visibilityState !== "visible"
    ) {
      return;
    }
    const now = Date.now();
    if (now >= lastReportedAt && now - lastReportedAt < REPORT_INTERVAL_MS) {
      return;
    }
    lastReportedAt = now;
    pending = true;
    // Presence is advisory. Drop a failed sample; retries or trailing timers would
    // manufacture a later interaction. New input may report again after settlement.
    const settled = () => {
      pending = false;
    };
    void client.request("presence.activity", {}).then(settled, settled);
  };
  const onReady = () => {
    if (gateway.snapshot.phase !== "connected" || visitedDocuments.has(documentTarget)) {
      return;
    }
    // A hidden initial connection consumes the visit too; becoming visible is not input.
    visitedDocuments.add(documentTarget);
    report();
  };
  const onInput = (event: Event) => {
    if (event.isTrusted) {
      report();
    }
  };
  for (const event of INPUT_EVENTS) {
    documentTarget.addEventListener(event, onInput, { capture: true, passive: true });
  }
  const unsubscribe = gateway.subscribe(onReady);
  onReady();
  return () => {
    disposed = true;
    unsubscribe();
    for (const event of INPUT_EVENTS) {
      documentTarget.removeEventListener(event, onInput, true);
    }
  };
}
