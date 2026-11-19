import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { handleNavigationClick } from "../../../lib/navigation-click.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { HandoffDisplay } from "../chat-sessions-yield.ts";
import type { ChatHandoffSession, HandoffSessionLinks } from "../chat-subagent-wait.ts";
import type { ProjectedContinuationSource } from "../chat-turn-boundary.ts";

/** A child's name: a link to its session when this viewer can open it, else text. */
function HandoffSessionName(props: { session: ChatHandoffSession; links?: HandoffSessionLinks }) {
  const link = createMemo(() => props.links?.(props.session.key));
  return (
    <Show when={link()} fallback={<span>{props.session.label}</span>}>
      {(target) => (
        <a
          href={target().href}
          onClick={(event) => handleNavigationClick(event, () => target().open())}
        >
          {props.session.label}
        </a>
      )}
    </Show>
  );
}

/** Each child with its status in words. */
function HandoffSessionList(props: {
  id: string;
  sessions: readonly ChatHandoffSession[];
  links?: HandoffSessionLinks;
}) {
  return (
    <ul id={props.id} class="chat-handoff-sessions">
      <For each={props.sessions} keyed={(session) => session.key}>
        {(session) => (
          <li data-status={session().status} title={session().note}>
            <HandoffSessionName session={session()} links={props.links} />{" "}
            <span class="chat-handoff-sessions__status">
              {t(`chat.handoffSessionStatus.${session().status}`)}
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

function elapsedText(elapsed: number) {
  return formatDurationCompact(Math.max(1_000, elapsed), { includeSeconds: true }) ?? "";
}

export function ChatContinuationDelay(props: { elapsed?: number }) {
  return (
    <Show when={props.elapsed}>
      {(elapsed) => (
        <span class="chat-tool-row__detail">
          {" "}
          <span aria-hidden="true">·</span>{" "}
          {t("chat.continuationDelay", { duration: elapsedText(elapsed()) })}
        </span>
      )}
    </Show>
  );
}

export function ChatContinuationActivity(props: {
  source: ProjectedContinuationSource;
  elapsed: number;
}) {
  return (
    <div class="chat-tool-msg-collapse">
      <div class="chat-tool-msg-summary chat-continuation-activity" data-source={props.source}>
        <span class="chat-tool-msg-summary__icon" aria-hidden="true">
          <Icon
            name={
              props.source === "exec" ? "terminal" : props.source === "subagent" ? "bot" : "history"
            }
          />
        </span>
        <span class="chat-tool-row__title">{t(`chat.continuationSource.${props.source}`)}</span>
        <ChatContinuationDelay elapsed={props.elapsed} />
      </div>
    </div>
  );
}

/**
 * An explicit handoff keeps its wait time and access-scoped child list.
 */
export function ChatHandoffResume(props: {
  handoff: HandoffDisplay & { resumedAt: number };
  sessions: readonly ChatHandoffSession[];
  links?: HandoffSessionLinks;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const label = () =>
    t("chat.handoffResumed", {
      duration: elapsedText(props.handoff.resumedAt - props.handoff.yieldedAt),
    });
  const count = () =>
    props.sessions.length === 1
      ? t("chat.handoffSessionsOne")
      : t("chat.handoffSessions", { count: String(props.sessions.length) });
  return (
    <div class="chat-handoff-resume chat-tool-msg-collapse">
      <Show
        when={props.sessions.length > 0}
        fallback={
          <div class="chat-handoff-resume__rule chat-tool-msg-summary">
            <span class="chat-tool-msg-summary__icon" aria-hidden="true">
              <Icon name="bot" />
            </span>
            <span class="chat-tool-row__title">{label()}</span>
          </div>
        }
      >
        <button
          type="button"
          class="chat-handoff-resume__rule chat-inline-disclosure chat-tool-msg-summary"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          onClick={() => setOpen(!open())}
        >
          <span class="chat-tool-msg-summary__icon" aria-hidden="true">
            <Icon name="bot" />
          </span>
          <span class="chat-tool-row__title">{label()}</span> <span aria-hidden="true">·</span>{" "}
          <span>{count()}</span>
          <span class="chat-inline-disclosure__chevron" aria-hidden="true">
            <Icon name="chevronDown" />
          </span>
        </button>
        <Show when={open()}>
          <HandoffSessionList id={id} sessions={props.sessions} links={props.links} />
        </Show>
      </Show>
    </div>
  );
}
