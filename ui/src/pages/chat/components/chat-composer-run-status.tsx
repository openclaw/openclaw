import { Show } from "solid-js";
import "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";

type ComposerRunStatusProps = {
  waitingSubagents: ChatSubagentWait | null;
  working: boolean;
  onOpenSubagents: ((focus?: boolean) => void) | undefined;
};

export function ComposerRunStatusContent(props: ComposerRunStatusProps) {
  const wait = () => props.waitingSubagents;
  const child = () => wait()?.child;
  const startedAt = () => child()?.startedAt ?? wait()?.startedAt;
  const label = () => {
    const current = wait();
    if (!current) {
      return t("common.working");
    }
    if (current.runningCount > 0) {
      return t(
        current.runningCount === 1 ? "chat.waitingOnSubagentCount" : "chat.waitingOnSubagentsCount",
        { count: String(current.runningCount) },
      );
    }
    return (current.sessionCount ?? 0) > 1
      ? t("chat.waitingOnSessionsCount", { count: String(current.sessionCount) })
      : current.sessionCount === 1
        ? t("chat.waitingOnSession")
        : t("chat.waitingOnSubagents");
  };
  return (
    <Show when={wait() || props.working}>
      <div
        class={[
          "agent-chat__composer-run-status",
          {
            "agent-chat__composer-run-status--waiting": Boolean(wait()),
            "agent-chat__composer-run-status--working": !wait(),
          },
        ]}
        role="status"
        aria-live="off"
      >
        <span class="agent-chat__composer-run-spinner" aria-hidden="true">
          <Icon name="loader" />
        </span>
        <span>{label()}</span>
        <Show when={child()}>
          <span aria-hidden="true">{" · "}</span>
          <span class="agent-chat__composer-wait-child" title={child()?.label}>
            {child()?.label}
          </span>
        </Show>
        <Show when={wait() && startedAt() != null}>
          <span aria-hidden="true">{" · "}</span>
          <span class="agent-chat__composer-wait-elapsed">
            {t("chat.composer.running")}{" "}
            <openclaw-elapsed-time prop:startMs={startedAt() ?? null} />
          </span>
        </Show>
        <Show
          when={
            wait() &&
            !((wait()?.sessionCount ?? 0) > 0 && wait()?.runningCount === 0) &&
            props.onOpenSubagents
          }
        >
          {" "}
          <button type="button" onClick={() => props.onOpenSubagents?.(true)}>
            {t("chat.composer.viewSubagents")}
          </button>
        </Show>
      </div>
    </Show>
  );
}

export const ComposerRunStatus = defineSolidBridge<ComposerRunStatusProps>(
  "openclaw-chat-composer-run-status",
  ComposerRunStatusContent,
  {
    properties: {
      waitingSubagents: { default: null, attribute: false },
      working: { default: false, attribute: false },
      onOpenSubagents: { default: undefined, attribute: false },
    },
    connected: (host) => {
      host.style.display = "contents";
    },
  },
);
