import { i18n, t } from "../i18n/index.ts";
import { registerUpdateActionsEnglish } from "../i18n/locales/en-update-actions.ts";
import { showToast, type ToastSeverity } from "../lib/toast.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { isNativeMobileHost } from "./native-web-chrome.ts";
import type { ApplicationOverlays } from "./overlays-types.ts";

/** The overlay owner reconciles the ledger on reconnect; the toast only presents its receipt. */
export function bindUpdateToast(
  gateway: ApplicationGateway,
  overlays: ApplicationOverlays,
  openDetails: () => void,
): () => void {
  if (isNativeMobileHost()) {
    return () => {};
  }
  let current: { runId: string; controller: AbortController; copyKey: string } | undefined;
  function publish() {
    const { updateRun: run, updateRunAcknowledged } = overlays.snapshot;
    if (run?.origin.noticeSurface !== "app" || updateRunAcknowledged) {
      current?.controller.abort();
      current = undefined;
      return;
    }
    registerUpdateActionsEnglish();
    const running = run.status === "running";
    const waiting = running && run.phase === "requested";
    const reconnecting = running && gateway.snapshot.phase !== "connected";
    const key = running ? (waiting ? "preparing" : "processing") : run.status;
    const message = reconnecting ? t("updates.dialog.reconnecting") : t(`updates.run.toast.${key}`);
    const description = reconnecting
      ? t("updates.run.reconnecting")
      : running && !waiting
        ? t(`updates.run.phase.${run.phase}`)
        : undefined;
    const actionLabel = running ? undefined : t("updates.run.toast.details");
    const severity: ToastSeverity = running
      ? "progress"
      : run.status === "succeeded"
        ? "success"
        : run.status === "failed"
          ? "error"
          : "warning";
    const copyKey = JSON.stringify([message, description, actionLabel, severity]);
    if (current?.runId !== run.runId) {
      current?.controller.abort();
      current = { runId: run.runId, controller: new AbortController(), copyKey: "" };
    }
    const receipt = current;
    if (receipt.copyKey === copyKey) {
      return;
    }
    receipt.copyKey = copyKey;
    showToast({
      message,
      description,
      severity,
      actionLabel,
      onAction: actionLabel ? openDetails : undefined,
      placement: "top-right",
      durationMs: null,
      dismissible: !running,
      dedupeKey: run.runId,
      signal: receipt.controller.signal,
      onDismiss: (reason) => {
        if (
          !running &&
          !receipt.controller.signal.aborted &&
          current === receipt &&
          (reason === "dismiss" || reason === "action")
        ) {
          overlays.acknowledgeUpdateRun();
        }
      },
    });
  }
  const release = [
    overlays.subscribe(publish),
    gateway.subscribe(publish),
    i18n.subscribe(publish),
  ];
  publish();
  return () => {
    release.forEach((stop) => stop());
    current?.controller.abort();
  };
}
