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

function Chevron(props: { open: boolean }) {
  return (
    <span class="chat-tool-row__chevron">
      <Icon name={props.open ? "chevronDown" : "chevronRight"} />
    </span>
  );
}

/**
 * Where a resumed handoff picks up again: how long it waited, what woke it, and
 * the children it waited on, closed until asked for.
 */
export function ChatHandoffResume(props: {
  handoff: HandoffDisplay & { resumedAt: number };
  sessions: readonly ChatHandoffSession[];
  links?: HandoffSessionLinks;
  source?: ProjectedContinuationSource;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const label = () => {
    const resumed = t("chat.handoffResumed", {
      duration:
        formatDurationCompact(Math.max(1_000, props.handoff.resumedAt - props.handoff.yieldedAt), {
          includeSeconds: true,
        }) ?? "",
    });
    return props.source ? `${resumed} · ${t(`chat.continuationSource.${props.source}`)}` : resumed;
  };
  const count = () =>
    props.sessions.length === 1
      ? t("chat.handoffSessionsOne")
      : t("chat.handoffSessions", { count: String(props.sessions.length) });
  return (
    <div class="chat-handoff-resume">
      <Show
        when={props.sessions.length > 0}
        fallback={<div class="chat-handoff-resume__rule">{label()}</div>}
      >
        <button
          type="button"
          class="chat-handoff-resume__rule"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          onClick={() => setOpen(!open())}
        >
          <span>{label()}</span> <span aria-hidden="true">·</span> <span>{count()}</span>
          <Chevron open={open()} />
        </button>
        <Show when={open()}>
          <HandoffSessionList id={id} sessions={props.sessions} links={props.links} />
        </Show>
      </Show>
    </div>
  );
}
