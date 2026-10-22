import { createMemo, Errored, For, Loading, Show } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";

type DiscoveryStatusProps = {
  request: { promise: Promise<void> } | undefined;
  emptyMessage?: string;
  emptyRole?: "alert";
  onRetry?: () => void;
  retryDisabled?: boolean;
};

export default function McpAppDiscoveryStatus(props: DiscoveryStatusProps) {
  return (
    <For
      each={props.request ? [props.request] : []}
      fallback={<p role="status">{t("mcpApp.loading")}</p>}
    >
      {(request) => {
        const read = createMemo(() => request.promise);
        return (
          <Errored
            fallback={(error) => (
              <>
                <p role="alert">{formatUiError(error())}</p>
                <Show when={props.onRetry}>
                  <button
                    class="btn"
                    disabled={props.retryDisabled}
                    onClick={() => props.onRetry?.()}
                  >
                    {t("mcpApp.retry")}
                  </button>
                </Show>
              </>
            )}
          >
            <Loading fallback={<p role="status">{t("mcpApp.loading")}</p>}>
              <Show when={read() === undefined && props.emptyMessage}>
                <p role={props.emptyRole}>{props.emptyMessage}</p>
              </Show>
            </Loading>
          </Errored>
        );
      }}
    </For>
  );
}
