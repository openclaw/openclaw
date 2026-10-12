import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import "../modal-dialog.ts";
import { Icon } from "./icon.tsx";

type ConfirmationProps = {
  pendingGatewayUrl: string | null;
  currentGatewayUrl: string;
  linkCarriesToken: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function renderConfirmation(props: () => ConfirmationProps) {
  const title = () => t("connection.switchGateway.title");
  const summary = () => t("connection.switchGateway.summary");
  const notes = () =>
    [
      t("connection.switchGateway.note"),
      props().linkCarriesToken ? t("connection.switchGateway.noteToken") : null,
      // Tokens are origin-scoped: a different origin never receives the saved one.
      props().currentGatewayUrl.trim() &&
      gatewayOriginScope(props().currentGatewayUrl) !==
        gatewayOriginScope(props().pendingGatewayUrl ?? "")
        ? t("connection.switchGateway.noteScoped", {
            host: formatGatewayHost(props().currentGatewayUrl),
          })
        : null,
    ]
      .filter(Boolean)
      .join(" ");
  return (
    <openclaw-modal-dialog
      label={title()}
      description={summary()}
      onModal-cancel={() => props().onCancel()}
    >
      <div class="gateway-switch">
        <div class="gateway-switch__head">
          <span class="gateway-switch__icon" aria-hidden="true">
            <Icon name="shieldAlert" />
          </span>
          <div class="gateway-switch__text">
            <h2 class="gateway-switch__title">{title()}</h2>
            <p class="gateway-switch__summary">{summary()}</p>
          </div>
        </div>
        <div class="gateway-switch__hosts">
          <div class="gateway-switch__host">
            <span class="gateway-switch__label">{t("connection.switchGateway.current")}</span>
            <code translate="no">{props().currentGatewayUrl.trim() || t("common.na")}</code>
          </div>
          <span class="gateway-switch__arrow" aria-hidden="true">
            <Icon name="arrowRight" />
          </span>
          <div class="gateway-switch__host gateway-switch__host--next">
            <span class="gateway-switch__label">{t("connection.switchGateway.next")}</span>
            <code translate="no">{props().pendingGatewayUrl}</code>
          </div>
        </div>
        <p class="gateway-switch__note">{notes()}</p>
        <div class="gateway-switch__actions">
          <button type="button" class="btn primary" onClick={() => props().onConfirm()}>
            {t("connection.switchGateway.confirm", {
              host: formatGatewayHost(props().pendingGatewayUrl ?? ""),
            })}
          </button>
          <button type="button" class="btn" onClick={() => props().onCancel()}>
            {t("connection.switchGateway.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}

export const GatewayUrlConfirmation = defineSolidBridge<{ props?: ConfirmationProps }>(
  "openclaw-gateway-url-confirmation",
  (props, host) => {
    host.style.display = "contents";
    return <>{props.props?.pendingGatewayUrl ? renderConfirmation(() => props.props!) : null}</>;
  },
  { properties: { props: { default: undefined, attribute: false } } },
);
