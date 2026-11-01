import { Show, createMemo } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "./chat-details-processes.css";
import type { createProcessesPresentation } from "./chat-processes-presentation.ts";

/** Shared compact row; callers retain navigation and presentation policy. */
export function ChatDetailsProcessRow(props: {
  row: SessionProcessSummary;
  elementRef?: (instanceId: string) => (element: HTMLDivElement) => void;
  onOpen?: (instanceId?: string) => void;
  presentation: ReturnType<typeof createProcessesPresentation>;
  hoverDescription?: boolean;
  disabled?: boolean;
}) {
  const stop = createMemo(() => props.presentation.createStop(() => props.row));
  const status = () => t(`chat.processesPanel.status.${props.row.status}`);
  const description = () => [props.row.name, status()].filter(Boolean).join(". ");
  const title = () => (props.hoverDescription ? description() : undefined);
  const content = () => (
    <>
      <span class="chat-details-processes__icon" aria-hidden="true">
        <Icon name="squareTerminal" />
        <span class="chat-details-processes__badge" data-status={props.row.status}>
          <span class="chat-details-processes__spinner" />
        </span>
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
    </>
  );
  return (
    <div
      ref={[props.elementRef?.(props.row.instanceId)]}
      class="chat-details-processes__row"
      role="listitem"
      data-process-id={props.row.processId}
      data-status={props.row.status}
      data-stopping={stop().stopping() ? "" : undefined}
      data-actionable={props.row.canStop ? "" : undefined}
    >
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
          onClick={() => props.onOpen?.(props.row.instanceId)}
        >
          {content()}
        </button>
      </Show>
      <Show when={props.row.canStop}>
        <button
          class="chat-details-processes__action chat-details-processes__stop"
          type="button"
          title={t("chat.processesPanel.stopProcess")}
          aria-label={t("chat.processesPanel.stop", { name: props.row.name })}
          disabled={props.disabled || stop().stopping()}
          onClick={() => {
            if (!props.disabled) {
              void stop().stop();
            }
          }}
        >
          <Show when={stop().stopping()} fallback={<Icon name="stop" />}>
            <span class="chat-details-processes__spinner" />
          </Show>
        </button>
      </Show>
      <Show when={stop().stopping()}>
        <span class="sr-only" role="status">
          {t("chat.processesPanel.stopping")}
        </span>
      </Show>
    </div>
  );
}
