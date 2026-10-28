import { createMemo, Errored } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";

export function McpAppOperationError(props: { result: Promise<null> }) {
  const outcome = createMemo(() => props.result, { loadingValue: null });
  return (
    <Errored fallback={(error) => <p role="alert">{formatUiError(error())}</p>}>
      {outcome()}
    </Errored>
  );
}
