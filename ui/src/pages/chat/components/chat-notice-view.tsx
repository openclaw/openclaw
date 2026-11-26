import { createMemo, Show } from "solid-js";
import { ChatNoticeDetails, type ChatNoticeProps } from "./chat-divider.tsx";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";

function FailureNotice(props: ChatNoticeProps) {
  const failure = () => props.item.runError!;
  const feedback = () => {
    const recovery = props.recovery;
    const agentId = recovery?.currentAgentId ?? recovery?.fullMessageAgentId;
    return recovery?.sessionKey && agentId
      ? {
          sessionKey: recovery.sessionKey,
          agentId,
          runId: failure().runId,
          repeatCount: props.item.repeatCount ?? 1,
        }
      : undefined;
  };
  const actions = createMemo(() => {
    // Bind the displayed failure: an open confirmation must not retarget a newer run.
    const initialRunId = failure().runId;
    const initialSummary = failure().summary;
    const recovery = props.recovery;
    if (
      !recovery ||
      initialRunId !== recovery.failureActionsRunId ||
      recovery.runActive ||
      recovery.runWorking
    ) {
      return undefined;
    }
    return {
      onRetry: recovery.onRetryRun ? () => recovery.onRetryRun?.(initialRunId) : undefined,
      onStartNewSession: recovery.onStartNewSession
        ? () => recovery.onStartNewSession?.(initialRunId, initialSummary)
        : undefined,
    };
  });
  return (
    <div
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      data-run-failure={failure().runId}
    >
      <ChatRunFailureNotice
        feedback={feedback()}
        summary={failure().summary}
        summaryAsTitle={failure().summaryAsTitle}
        cause={failure().cause}
        presentation={props.modelCatalog?.find(
          (model) => model.provider === failure().cause?.provider,
        )}
        repeatCount={props.item.repeatCount}
        onRetry={actions()?.onRetry}
        onStartNewSession={actions()?.onStartNewSession}
      />
    </div>
  );
}

export function ChatNotice(props: ChatNoticeProps) {
  return (
    <Show when={props.item.runError?.runId} keyed fallback={<ChatNoticeDetails {...props} />}>
      <FailureNotice
        item={props.item}
        recovery={props.recovery}
        modelCatalog={props.modelCatalog}
      />
    </Show>
  );
}
