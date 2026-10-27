import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { handleNavigationClick } from "../../../lib/navigation-click.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { HandoffDisplay } from "../chat-sessions-yield.ts";
import type {
  ChatHandoffSession,
  ChatSubagentWait,
  HandoffSessionLinks,
} from "../chat-subagent-wait.ts";

function needsInputLabel(count: number) {
  return count === 1
    ? t("chat.sessionsNeedInputOne")
    : t("chat.sessionsNeedInput", { count: String(count) });
}

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

/** A sentence with one child's name in it, linked like the list rows. */
function NamedSentence(props: {
  text: string;
  session: ChatHandoffSession;
  links?: HandoffSessionLinks;
}) {
  const parts = createMemo(() => props.text.split("\u0000"));
  return (
    <span>
      {parts()[0]}
      <HandoffSessionName session={props.session} links={props.links} />
      {parts()[1] ?? ""}
    </span>
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
 * The working line while a handoff waits on its children: one child is named
 * in place; several get a list, open until the reader closes it.
 */
function HandoffWaitLine(props: {
  wait: ChatSubagentWait;
  startMs: number;
  links?: HandoffSessionLinks;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(true);
  const only = createMemo(() =>
    props.wait.sessions.length === 1 ? props.wait.sessions[0] : undefined,
  );
  const count = (status: ChatHandoffSession["status"]) =>
    props.wait.sessions.filter((session) => session.status === status).length;
  const attention = createMemo(() => count("attention"));
  const paused = createMemo(() => count("paused"));
  // Nothing is working while every remaining child is paused, so no clock runs.
  const timed = createMemo(() => paused() === 0 || count("running") > 0);
  const elapsed = () => (
    <Show when={timed()}>
      <span aria-hidden="true">·</span>{" "}
      <ElapsedTime class="chat-working-indicator__elapsed" startMs={props.startMs} />
    </Show>
  );
  return (
    <div class="chat-subagent-wait">
      <Show
        when={only()}
        fallback={
          <>
            <button
              type="button"
              class="chat-subagent-wait__toggle chat-working-indicator__status"
              aria-expanded={open() ? "true" : "false"}
              aria-controls={id}
              onClick={() => setOpen(!open())}
            >
              <span>
                {t("chat.waitingOnSessions", { count: String(props.wait.sessions.length) })}
              </span>{" "}
              <Show when={attention() > 0}>
                <span aria-hidden="true">·</span>{" "}
                <span class="chat-subagent-wait__attention">
                  {needsInputLabel(attention())}
                </span>{" "}
              </Show>
              <Show when={paused() > 0}>
                <span aria-hidden="true">·</span>{" "}
                <span>{t("chat.sessionsPaused", { count: String(paused()) })}</span>{" "}
              </Show>
              {elapsed()}
              <Chevron open={open()} />
            </button>
            <Show when={open()}>
              <HandoffSessionList id={id} sessions={props.wait.sessions} links={props.links} />
            </Show>
          </>
        }
      >
        {(session) => (
          <span class="chat-working-indicator__status">
            <NamedSentence
              text={t("chat.waitingOnSubagent", { name: "\u0000" })}
              session={session()}
              links={props.links}
            />{" "}
            <Show when={session().status === "attention" || session().status === "paused"}>
              <span aria-hidden="true">·</span>{" "}
              <span
                class={{ "chat-subagent-wait__attention": session().status === "attention" }}
                title={session().note}
              >
                {t(`chat.handoffSessionStatus.${session().status}`)}
              </span>{" "}
            </Show>
            {elapsed()}
          </span>
        )}
      </Show>
    </div>
  );
}

/**
 * The handoff's line under the transcript. After the parent resumes with only
 * paused children left, nothing is working: a quiet note names them instead.
 */
export function ChatSubagentWaitLine(props: {
  wait: ChatSubagentWait;
  startMs: number;
  links?: HandoffSessionLinks;
}) {
  const only = () => (props.wait.sessions.length === 1 ? props.wait.sessions[0] : undefined);
  return (
    <Show
      when={props.wait.pausedNote}
      fallback={<HandoffWaitLine wait={props.wait} startMs={props.startMs} links={props.links} />}
    >
      <div class="chat-subagent-wait">
        <span class="chat-working-indicator__status">
          <Show
            when={only()}
            fallback={t("chat.sessionsPausedNote", { count: String(props.wait.sessions.length) })}
          >
            {(session) => (
              <NamedSentence
                text={t("chat.sessionPausedNote", { name: "\u0000" })}
                session={session()}
                links={props.links}
              />
            )}
          </Show>
        </span>
      </div>
    </Show>
  );
}

/**
 * Where a resumed handoff picks up again: how long it waited, and the children
 * it waited on, closed until asked for.
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
      duration:
        formatDurationCompact(Math.max(1_000, props.handoff.resumedAt - props.handoff.yieldedAt), {
          includeSeconds: true,
        }) ?? "",
    });
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
