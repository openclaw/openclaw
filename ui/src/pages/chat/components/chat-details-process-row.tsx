import { Show } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { t } from "../../../lib/reactive/i18n.ts";

/** Shared compact row; callers retain navigation and presentation policy. */
export function ChatDetailsProcessRow(props: {
  row: SessionProcessSummary;
  onOpen?: () => void;
  hoverDescription?: boolean;
  disabled?: boolean;
}) {
  const status = () => t(`chat.processesPanel.status.${props.row.status}`);
  const lastLine = () => props.row.tail.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const description = () => [props.row.name, status(), lastLine()].filter(Boolean).join(". ");
  const title = () => (props.hoverDescription ? description() : undefined);
  const content = () => (
    <>
      <span class="chat-details__process-icon" data-status={props.row.status} aria-hidden="true">
        <Icon name="terminal" />
      </span>
      <span
        ref={createTextOverflow(() => props.row.name)}
        class="chat-details__process-name"
        title={props.row.name}
      >
        {props.row.name}
      </span>
      <span class="chat-details__process-elapsed" aria-hidden="true">
        <ElapsedTime startMs={props.row.startedAt} endMs={props.row.endedAt ?? null} />
      </span>
      <span
        ref={createTextOverflow(() => lastLine() || status())}
        class="chat-details__process-tail"
        title={lastLine() || status()}
      >
        {lastLine() || status()}
      </span>
    </>
  );
  return (
    <div role="listitem" data-process-id={props.row.processId}>
      <Show
        when={props.onOpen}
        fallback={
          <div class="chat-details__process" title={title()}>
            {content()}
          </div>
        }
      >
        <button
          type="button"
          class="chat-details__process"
          title={title()}
          aria-label={description()}
          disabled={props.disabled}
          onClick={() => props.onOpen?.()}
        >
          {content()}
        </button>
      </Show>
    </div>
  );
}
