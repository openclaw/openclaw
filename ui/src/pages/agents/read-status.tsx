import { createMemo, Errored, For, isPending, latest, Loading } from "solid-js";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import type { AgentReadOutcome } from "../../lib/agents/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

type AgentRead = Promise<AgentReadOutcome<unknown> | null> | null;

export function createAgentReadPending(source: () => AgentRead) {
  // Undefined is first paint; the owner settles retired requests with null.
  const outcome = createMemo(() => source() ?? undefined, { loadingValue: undefined });
  return createMemo(
    () => source() !== null && (isPending(outcome) || latest(outcome) === undefined),
  );
}

export function AgentReadNotice(props: { request: AgentRead; style?: { "margin-top": string } }) {
  return (
    <For each={props.request ? [props.request] : []}>
      {(request) => (
        <Errored
          fallback={(error) => (
            <InlineAlert tone="danger" role="alert" style={props.style}>
              {formatUiError(error())}
            </InlineAlert>
          )}
        >
          <Loading>
            <AgentReadCompletion request={request} />
          </Loading>
        </Errored>
      )}
    </For>
  );
}

function AgentReadCompletion(props: { request: NonNullable<AgentRead> }) {
  const completion = createMemo(async () => {
    const outcome = await props.request;
    if (outcome?.error !== undefined) {
      throw new Error(outcome.error);
    }
    return null;
  });
  return <>{completion()}</>;
}
