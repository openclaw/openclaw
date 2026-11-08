import { Show } from "solid-js";
import type { ControlUiInlineAlertProps } from "../../../src/plugin-sdk/control-ui-components.js";
import { ErrorDetails } from "../components/config-error.tsx";
import { CopyButton } from "../components/solid/copy-button.tsx";
import { InlineAlert } from "../components/solid/inline-alert.tsx";
import { formatUiErrorDetails } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";

export type PluginInlineAlertProps = { alert: ControlUiInlineAlertProps | null };

function PluginInlineAlertContent(props: PluginInlineAlertProps) {
  return (
    <Show when={props.alert} keyed>
      {(alert) => (
        <InlineAlert
          tone={alert.tone}
          title={alert.title}
          action={
            alert.action ? (
              <button
                type="button"
                class="btn btn--sm"
                disabled={alert.action.disabled}
                onClick={() => alert.action?.onSelect()}
              >
                {alert.action.label}
              </button>
            ) : undefined
          }
          onDismiss={alert.onDismiss}
        >
          <div>{alert.message}</div>
          <ErrorDetails
            error={alert.detail || null}
            label={t("chat.errorDetails")}
            action={
              <CopyButton
                text={formatUiErrorDetails(alert.detail ?? "")}
                idleLabel={t("chat.copyError")}
                bare
                iconFeedback
              />
            }
          />
        </InlineAlert>
      )}
    </Show>
  );
}

export const PluginInlineAlert = defineSolidBridge<PluginInlineAlertProps>(
  "openclaw-plugin-inline-alert",
  PluginInlineAlertContent,
  { properties: { alert: { default: null, attribute: false } } },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-inline-alert": SolidBridgeElement<PluginInlineAlertProps>;
  }
}
