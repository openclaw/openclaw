import { Show } from "solid-js";
import { renderMcpServerForm, type McpServerForm } from "../../../components/mcp-server-form.ts";
import { SettingsSegmented } from "../../../components/solid/settings-ui.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "./chat-composer-interop.tsx";

export type ComposerAddServerDialogProps = {
  open: boolean;
  busy: boolean;
  scope: "session" | "everywhere";
  scopeBlockedReason: string | null;
  submitBlockedReason: string | null;
  error: string | null;
  onScopeChange: (scope: "session" | "everywhere") => void;
  onCancel: () => void;
  onSubmit: (form: McpServerForm) => void;
};

export function ComposerAddServerDialog(props: ComposerAddServerDialogProps) {
  return (
    <Show when={props.open}>
      <openclaw-modal-dialog
        label={t("chat.composer.menu.addMcpServerTitle")}
        description={t("chat.composer.menu.addMcpServerDescription")}
        onModal-cancel={(event) => {
          if (props.busy) {
            event.preventDefault();
          } else {
            props.onCancel();
          }
        }}
      >
        <div class="exec-approval-card mcp-server-dialog">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">{t("chat.composer.menu.addMcpServerTitle")}</div>
              <div class="exec-approval-sub">{t("chat.composer.menu.addMcpServerDescription")}</div>
            </div>
          </div>
          <div class="mcp-server-dialog__scope">
            <span>{t("chat.composer.menu.scopeLabel")}</span>
            <SettingsSegmented
              value={props.scope}
              options={[
                { value: "session", label: t("chat.composer.menu.scopeSession") },
                { value: "everywhere", label: t("chat.composer.menu.scopeEverywhere") },
              ]}
              ariaLabel={t("chat.composer.menu.scopeLabel")}
              disabled={props.busy || props.scopeBlockedReason !== null}
              onChange={props.onScopeChange}
            />
            <span class="mcp-server-dialog__scope-hint">
              {t(
                props.scope === "session"
                  ? "chat.composer.menu.scopeSessionHint"
                  : "chat.composer.menu.scopeEverywhereHint",
              )}
            </span>
          </div>
          <LitContent
            value={renderMcpServerForm({
              busy: props.busy,
              disabled: props.submitBlockedReason !== null,
              blockedReason: props.submitBlockedReason,
              autofocus: true,
              onSubmit: props.onSubmit,
              onCancel: props.onCancel,
            })}
          />
          <Show when={props.error}>
            {(error) => (
              <div class="mcp-server-message mcp-server-message--error" role="alert">
                {error()}
              </div>
            )}
          </Show>
        </div>
      </openclaw-modal-dialog>
    </Show>
  );
}
