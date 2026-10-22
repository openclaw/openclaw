import { createMemo, Errored, isPending, latest, Loading, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";

type ProbeResult = "unavailable" | "sign-in" | undefined;

export default function BrowserAuthRecoveryDialog(props: {
  view: { openedSignIn: boolean; probe: Promise<void> | undefined; probeResult: ProbeResult };
  readProbeResult: () => ProbeResult;
  onSignIn: () => void;
  onCheck: () => void;
  onDismiss: () => void;
}) {
  // Probe settlement reads the synchronous owner before its snapshot update flushes.
  const probeRead = createMemo(
    () => props.view.probe?.then(props.readProbeResult) ?? props.view.probeResult,
  );
  return (
    <openclaw-modal-dialog
      label={t("connection.browserSignIn.title")}
      description={t("connection.browserSignIn.description")}
      onModal-cancel={() => props.onDismiss()}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div style={{ "min-width": "0" }}>
            <div class="exec-approval-title">{t("connection.browserSignIn.title")}</div>
            <div class="exec-approval-sub" style={{ "white-space": "normal" }}>
              {t("connection.browserSignIn.description")}
            </div>
          </div>
        </div>
        <Show when={props.view.openedSignIn}>
          <p>{t("connection.browserSignIn.returnHint")}</p>
        </Show>
        <p role="status" aria-live="polite">
          <Errored fallback={t("connection.browserSignIn.unavailable")}>
            <Loading>
              {isPending(probeRead)
                ? t("connection.browserSignIn.checking")
                : latest(probeRead) === "unavailable"
                  ? t("connection.browserSignIn.unavailable")
                  : latest(probeRead) === "sign-in"
                    ? t("connection.browserSignIn.stillRequired")
                    : null}
            </Loading>
          </Errored>
        </p>
        <openclaw-modal-actions class="exec-approval-actions">
          <button class="btn" onClick={() => props.onDismiss()}>
            {t("connection.browserSignIn.dismiss")}
          </button>
          <Show when={props.view.openedSignIn}>
            <button class="btn" disabled={isPending(probeRead)} onClick={() => props.onCheck()}>
              {t("connection.browserSignIn.checkAgain")}
            </button>
          </Show>
          <button class="btn primary" onClick={() => props.onSignIn()}>
            {t("connection.browserSignIn.action")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
