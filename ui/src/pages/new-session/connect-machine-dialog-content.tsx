import { action, createOptimistic, onSettled, Show } from "solid-js";
import { ConnectCommand } from "../../components/solid/connect-command.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { formatTimeMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConnectMachineRequest, ConnectMachineSetupState } from "./connect-machine-dialog.ts";

export function ConnectMachineDialogContent(props: ReturnType<ConnectMachineSetupState["view"]>) {
  const [saving, setSaving] = createOptimistic(false);
  const presentRequest = action(function* (request: ConnectMachineRequest) {
    if (request.isCurrent()) {
      setSaving(true);
    }
    yield Promise.race([request.completion, request.retired]);
  });
  // The owner replays an in-flight request when the dialog content first loads.
  onSettled(() =>
    props.subscribeRequests((request) => {
      // The native modal must finish opening before its operation joins an action.
      onSettled(() => {
        void presentRequest(request).catch(request.reportError);
      });
    }),
  );
  const busy = () => saving() || props.loading;
  const expiresAt = () =>
    props.setup?.expiresAtMs
      ? formatTimeMs(props.setup.expiresAtMs, { hour: "numeric", minute: "2-digit" }, "")
      : "";
  return (
    <>
      <div class="oc-dialog__body connect-machine-dialog__body">
        {busy() && !props.setup?.command ? (
          <p class="connect-machine-dialog__status" role="status">
            {t("newSession.connectMachineGenerating")}
          </p>
        ) : undefined}
        {props.error ? (
          <InlineAlert tone="danger" role="alert">
            <p>{t("newSession.connectMachineFailed")}</p>
            <p>{props.error}</p>
          </InlineAlert>
        ) : undefined}
        <Show when={props.setup}>
          {(setup) => (
            <>
              <ConnectCommand command={setup().command} />
              <p class="connect-machine-dialog__hint">{t("newSession.connectMachineTeamHint")}</p>
              <p class="connect-machine-dialog__hint">
                {t("newSession.connectMachineInstalled")}{" "}
                <code translate="no" style={{ "overflow-wrap": "anywhere" }}>
                  {setup().installedCommand}
                </code>
              </p>
              <p class="connect-machine-dialog__hint" hidden={!setup().versionNote}>
                {setup().versionNote}
              </p>
              <details>
                <summary>{t("newSession.connectMachineCommandOnly")}</summary>
                <ConnectCommand command={setup().serviceCommand} />
              </details>
              <p class="connect-machine-dialog__hint">
                {expiresAt()
                  ? t("newSession.connectMachineSingleUseExpires", { time: expiresAt() })
                  : t("newSession.connectMachineSingleUse")}
              </p>
            </>
          )}
        </Show>
      </div>
      <openclaw-modal-actions class="oc-dialog__footer connect-machine-dialog__actions">
        {props.setup?.command || props.error ? (
          <button class="btn" type="button" disabled={busy()} onClick={() => props.onRefresh()}>
            <Icon name="refresh" />
            {busy()
              ? t("newSession.connectMachineRefreshing")
              : t("newSession.connectMachineFreshCode")}
          </button>
        ) : undefined}
        <button class="btn btn--ghost" type="button" onClick={() => props.onManageDevices()}>
          {t("newSession.connectMachineManageDevices")}
        </button>
      </openclaw-modal-actions>
    </>
  );
}
