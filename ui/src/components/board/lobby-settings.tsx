import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardGrantDecision } from "../../lib/board/view-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { ModalDialog } from "../modal-dialog.tsx";
import { DialogHeader } from "../solid/dialog-header.tsx";
import { Icon } from "../solid/icon.tsx";
import type { BoardViewProps } from "./board-view-state.ts";
import { LobbyAccessDetails } from "./lobby-access-details.tsx";

type PermissionRequest = {
  callbacks: BoardViewProps["callbacks"];
  sessionKey: string | undefined;
  agentId: string | undefined;
  name: string;
  revision: number;
  instanceId: string | undefined;
  pending: boolean;
  error?: string;
};

/** Presentation only: the existing provider owns grant revision, persistence and frame retirement. */
export function LobbySettings(props: BoardViewProps & { componentName?: string }) {
  const widgets = createMemo(() =>
    (props.snapshot?.widgets ?? []).filter(
      (widget) =>
        (!props.componentName || widget.name === props.componentName) &&
        (widget.grantState !== "none" ||
          (widget.declared?.netOrigins?.length ?? 0) > 0 ||
          (widget.declared?.tools?.length ?? 0) > 0 ||
          (widget.declared?.actionBindings?.length ?? 0) > 0 ||
          (widget.declared?.queries?.length ?? 0) > 0),
    ),
  );
  const [open, setOpen] = createSignal(false);
  const native = () =>
    Boolean(
      // SAFETY: WKWebView installs this optional native handler; absence uses the web UI.
      (window as Window & { webkit?: { messageHandlers?: { openclawLobbyPrompt?: unknown } } })
        .webkit?.messageHandlers?.openclawLobbyPrompt,
    );
  const openSettings = () => {
    if (props.active) {
      setOpen(true);
    }
  };
  onSettled(() => listen(document, "openclaw-lobby-settings", openSettings));
  const [request, setRequest] = createSignal<PermissionRequest>();
  let inFlight: PermissionRequest | undefined;
  const matches = (value: PermissionRequest) =>
    value.callbacks === props.callbacks &&
    value.sessionKey === props.snapshot?.sessionKey &&
    value.agentId === props.session.agentId &&
    props.snapshot?.widgets.some(
      (widget) =>
        widget.name === value.name &&
        widget.revision === value.revision &&
        widget.instanceId === value.instanceId,
    ) === true;
  const current = createMemo(() => {
    const value = request();
    return value && matches(value) ? value : undefined;
  });
  const disabled = () =>
    !props.active || !props.canGrant || !props.callbacks || current()?.pending === true;
  async function decide(widget: BoardWidget, decision: BoardGrantDecision) {
    if (disabled() || (inFlight && matches(inFlight))) {
      return;
    }
    const callbacks = props.callbacks;
    if (!callbacks) {
      return;
    }
    const next: PermissionRequest = {
      callbacks,
      sessionKey: props.snapshot?.sessionKey,
      agentId: props.session.agentId,
      name: widget.name,
      revision: widget.revision,
      instanceId: widget.instanceId,
      pending: true,
    };
    inFlight = next;
    setRequest(next);
    try {
      await callbacks.grant(widget.name, decision);
      if (inFlight === next && matches(next)) {
        setRequest(undefined);
      }
    } catch (error) {
      if (inFlight === next && matches(next)) {
        setRequest({ ...next, pending: false, error: formatUiError(error) });
      }
    } finally {
      if (inFlight === next) {
        inFlight = undefined;
      }
    }
  }
  return (
    <>
      <Show when={!native()}>
        <div class="lobby-settings__toolbar">
          <button
            type="button"
            class="btn btn--small lobby-settings__trigger"
            data-test-id="lobby-settings-open"
            disabled={!props.active}
            onClick={() => setOpen(true)}
          >
            <Icon name="settings" />
            {t("board.lobby.settings")}
          </button>
        </div>
      </Show>
      <Show when={open() && props.active}>
        <ModalDialog
          class="lobby-settings"
          label={t("board.lobby.settings")}
          onModal-cancel={() => setOpen(false)}
        >
          <div class="oc-dialog">
            <DialogHeader
              title={t("board.lobby.permissions")}
              description={t("board.lobby.permissionScope")}
              onClose={() => setOpen(false)}
            />
            <div class="oc-dialog__body lobby-settings__body">
              <p class="muted">{t("board.lobby.executorRequirements")}</p>
              <Show when={!props.canGrant}>
                <p role="status">{t("board.lobby.readOnlyPermissions")}</p>
              </Show>
              <Show
                when={widgets().length}
                fallback={
                  <p data-test-id="lobby-permissions-empty">{t("board.lobby.noPermissions")}</p>
                }
              >
                <For each={widgets()} keyed={(widget) => widget.name}>
                  {(widget) => (
                    <section
                      class="lobby-settings__component"
                      data-permission-component={widget().name}
                    >
                      <h3>{widget().title || widget().name}</h3>
                      <p class="lobby-settings__state" data-test-id="lobby-permission-state">
                        {t(`board.lobby.permissionState.${widget().grantState}`)}
                      </p>
                      <LobbyAccessDetails widget={widget()} />
                      <Show when={widget().grantState !== "none"}>
                        <div class="lobby-settings__actions">
                          <Show when={widget().grantState !== "granted"}>
                            <button
                              type="button"
                              class="btn btn--small btn--primary"
                              data-test-id="lobby-permission-allow"
                              disabled={disabled()}
                              onClick={() => void decide(widget(), "granted")}
                            >
                              {t("board.widget.allow")}
                            </button>
                          </Show>
                          <Show when={widget().grantState !== "rejected"}>
                            <button
                              type="button"
                              class="btn btn--small"
                              data-test-id="lobby-permission-deny"
                              disabled={disabled()}
                              onClick={() => void decide(widget(), "rejected")}
                            >
                              {t(
                                widget().grantState === "granted"
                                  ? "board.lobby.revoke"
                                  : "board.lobby.deny",
                              )}
                            </button>
                          </Show>
                        </div>
                      </Show>
                      <Show when={current()?.name === widget().name && current()?.pending}>
                        <p role="status">{t("common.saving")}</p>
                      </Show>
                      <Show when={current()?.name === widget().name && current()?.error}>
                        <p role="alert">{current()?.error}</p>
                      </Show>
                    </section>
                  )}
                </For>
              </Show>
            </div>
            <openclaw-modal-actions>
              <button type="button" class="btn" onClick={() => setOpen(false)}>
                {t("common.close")}
              </button>
            </openclaw-modal-actions>
          </div>
        </ModalDialog>
      </Show>
    </>
  );
}
