import { Errored } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function ApprovalErrorNotice(props: {
  error: string | null;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const readError = () => {
    if (props.error) {
      throw new Error(props.error);
    }
    return null;
  };
  return (
    <Errored
      fallback={(error, reset) => (
        <div class="callout danger" role="alert">
          {formatUiError(error())}
          {props.onRetry ? (
            <button
              class="btn btn--sm"
              disabled={props.retryDisabled}
              onClick={() => {
                props.onRetry?.();
                reset();
              }}
            >
              {t("common.retry")}
            </button>
          ) : null}
        </div>
      )}
    >
      {readError()}
    </Errored>
  );
}
