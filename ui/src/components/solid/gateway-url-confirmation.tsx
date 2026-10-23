import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import {
  children,
  createSignal,
  Errored,
  isPending,
  lazy,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { formatGatewayHost } from "../../lib/gateway-host.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";
import { LazyViewError } from "./lazy-view-error.tsx";
import { LoadingState } from "./loading-state.tsx";

const ModalDialog = lazy(() => import("../modal-dialog.tsx"), { export: "ModalDialog" });

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
  const content = children(() => (
    <ModalDialog label={title()} description={summary()} onModal-cancel={() => props().onCancel()}>
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
        <openclaw-modal-actions class="gateway-switch__actions">
          <button type="button" class="btn" onClick={() => props().onCancel()}>
            {t("connection.switchGateway.cancel")}
          </button>
          <button type="button" class="btn primary" onClick={() => props().onConfirm()}>
            {t("connection.switchGateway.confirm", {
              host: formatGatewayHost(props().pendingGatewayUrl ?? ""),
            })}
          </button>
        </openclaw-modal-actions>
      </div>
    </ModalDialog>
  ));
  return (
    <Errored
      fallback={(error, reset) => {
        let active = true;
        const [retrying, setRetrying] = createSignal(false);
        const stale = isStaleChunkImportError(error());
        onSettled(() => () => {
          active = false;
          if (stale) {
            cancelStaleChunkRecovery();
          }
        });
        const retry = async () => {
          if (!active) {
            return;
          }
          setRetrying(true);
          if (stale && (await retryStaleChunkReloadWhenReachable({ canReload: () => active }))) {
            return;
          }
          if (active) {
            setRetrying(false);
            reset();
          }
        };
        return (
          <Show when={!retrying() && !isPending(content)} fallback={<LoadingState />}>
            <LazyViewError
              error={error()}
              stale={stale}
              subtitle={title()}
              actionLabel={t("common.retry")}
              onRetry={() => void retry()}
              onClose={() => props().onCancel()}
            />
          </Show>
        );
      }}
    >
      <Loading fallback={<LoadingState />}>{content()}</Loading>
    </Errored>
  );
}

export function GatewayUrlConfirmation(input: { props?: ConfirmationProps }) {
  return (
    <openclaw-gateway-url-confirmation style="display: contents">
      <Show when={input.props?.pendingGatewayUrl ? input.props : undefined}>
        {(confirmation) => renderConfirmation(confirmation)}
      </Show>
    </openclaw-gateway-url-confirmation>
  );
}
