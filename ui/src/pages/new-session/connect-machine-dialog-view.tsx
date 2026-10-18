import { Show } from "solid-js";
import { ConnectCommand } from "../../components/solid/connect-command.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConnectMachineSetupState } from "./connect-machine-dialog.ts";

export function ConnectMachineDialog(props: ReturnType<ConnectMachineSetupState["view"]>) {
  const expiresAt = () =>
    props.setup?.expiresAtMs
      ? formatTimeMs(props.setup.expiresAtMs, { hour: "numeric", minute: "2-digit" }, "")
      : "";
  return (
    <Show when={props.open}>
      <openclaw-modal-dialog
        class="connect-machine-dialog"
        label={t("newSession.connectMachineTitle")}
        description={t("newSession.connectMachineDescription")}
        onModal-cancel={() => props.onClose()}
      >
        <section class="exec-approval-card connect-machine-dialog__card">
          <header class="exec-approval-header">
            <div>
              <h2 class="exec-approval-title">{t("newSession.connectMachineTitle")}</h2>
              <p class="exec-approval-sub">{t("newSession.connectMachineDescription")}</p>
            </div>
            <button
              class="btn btn--icon btn--ghost"
              type="button"
              aria-label={t("common.dismiss")}
              onClick={() => props.onClose()}
            >
              <Icon name="x" />
            </button>
          </header>
          <div class="connect-machine-dialog__body">
            {props.loading && !props.setup?.command ? (
              <p class="connect-machine-dialog__status" role="status">
                {t("newSession.connectMachineGenerating")}
              </p>
            ) : undefined}
            {props.error ? (
              <p class="exec-approval-error" role="alert">
                {t("newSession.connectMachineFailed")} {props.error}
              </p>
            ) : undefined}
            <Show when={props.setup}>
              {(setup) => (
                <>
                  <ConnectCommand command={setup().command} />
                  <p class="connect-machine-dialog__hint">
                    {t("newSession.connectMachineTeamHint")}
                  </p>
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
          <openclaw-modal-actions class="exec-approval-actions connect-machine-dialog__actions">
            {props.setup?.command || props.error ? (
              <button
                class="btn"
                type="button"
                disabled={props.loading}
                onClick={() => props.onRefresh()}
              >
                <Icon name="refresh" />
                {props.loading
                  ? t("newSession.connectMachineRefreshing")
                  : t("newSession.connectMachineFreshCode")}
              </button>
            ) : undefined}
            <button class="btn btn--ghost" type="button" onClick={() => props.onManageDevices()}>
              {t("newSession.connectMachineManageDevices")}
            </button>
          </openclaw-modal-actions>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}
