import { Errored } from "solid-js";
import { RetryAction } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";

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
            <RetryAction
              disabled={props.retryDisabled}
              onRetry={() => {
                props.onRetry?.();
                reset();
              }}
            />
          ) : null}
        </div>
      )}
    >
      {readError()}
    </Errored>
  );
}
