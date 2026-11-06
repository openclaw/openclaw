import { createMemo, Show } from "solid-js";
import { ChatNoticeDetails, type ChatNoticeProps } from "./chat-divider.tsx";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";

function FailureNotice(props: ChatNoticeProps) {
  const failure = () => props.item.runError!;
  const actions = createMemo(() => {
    // Bind the displayed failure: an open confirmation must not retarget a newer run.
    const initialRunId = failure().runId;
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
      editSource: recovery.failedMessageEditSource,
    };
  });
  return (
    <div
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      data-run-failure={failure().runId}
    >
      <ChatRunFailureNotice
        summary={failure().summary}
        cause={failure().cause}
        repeatCount={props.item.repeatCount}
        onRetry={actions()?.onRetry}
        onOpenModels={props.recovery?.onOpenModelProvider}
        editSource={actions()?.editSource}
        onFocusComposer={props.recovery?.onFocusComposer}
      />
    </div>
  );
}

export function ChatNotice(props: ChatNoticeProps) {
  return (
    <Show when={props.item.runError} fallback={<ChatNoticeDetails {...props} />}>
      <FailureNotice item={props.item} recovery={props.recovery} />
    </Show>
  );
}
