import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { DelegatedTask, DelegatedTaskGroup } from "../chat-delegation.ts";

registerChatToolLabelsEnglish();
const failed = (task: DelegatedTask) =>
  task.status === "failed" || task.status === "killed" || task.status === "timeout";
const finished = (task: DelegatedTask) => task.status === "done" || failed(task);
const icon = (task: DelegatedTask) =>
  failed(task)
    ? "alertTriangle"
    : task.status === "done"
      ? "check"
      : task.status === "running"
        ? "loader"
        : "clock";

export type ChatDelegationProps = {
  groups: readonly DelegatedTaskGroup[];
  onOpenSubagent?: (sessionKey: string) => void;
  onOpenSession?: (sessionKey: string) => void;
};

export function ChatDelegation(props: ChatDelegationProps) {
  return (
    <div class="chat-delegation" data-test-id="chat-delegation">
      <For each={props.groups} keyed={(group) => group.key}>
        {(group) => (
          <TaskGroup
            group={group()}
            onOpen={(key) => (props.onOpenSubagent ?? props.onOpenSession)?.(key)}
          />
        )}
      </For>
    </div>
  );
}

function TaskGroup(props: { group: DelegatedTaskGroup; onOpen: (key: string) => void }) {
  const tasks = () => props.group.tasks;
  const counts = createMemo(() => ({
    complete: tasks().filter(finished).length,
    failed: tasks().filter(failed).length,
    unknown: tasks().filter((task) => task.status === "unknown").length,
  }));
  const visibleTasks = createMemo(() => {
    const all = tasks();
    return all.length <= 64
      ? all
      : [...all.filter((task) => !finished(task)), ...all.filter(finished)].slice(0, 64);
  });
  const settled = () => counts().complete + counts().unknown === tasks().length;
  // Large active batches expand initially; finishing collapses the untouched default.
  // An explicit reader choice survives live status updates.
  const [expanded, setExpanded] = createSignal<boolean | undefined>(undefined);
  const open = () => expanded() ?? (tasks().length > 5 && !settled());
  const title = () =>
    tasks().length === 1
      ? tasks()[0]!.label || t("chat.toolCards.delegation.task")
      : t(
          tasks().length > 5
            ? "chat.toolCards.delegation.parallel"
            : "chat.toolCards.delegation.tasks",
          {
            count: String(tasks().length),
          },
        );
  const status = () =>
    counts().failed
      ? t("chat.toolCards.delegation.attention", { count: String(counts().failed) })
      : counts().unknown
        ? t("chat.toolCards.delegation.unknown")
        : settled()
          ? t("common.completed")
          : tasks().length === 1
            ? t("chat.toolCards.delegation." + tasks()[0]!.status)
            : t("chat.toolCards.delegation.progress", {
                complete: String(counts().complete),
                total: String(tasks().length),
              });
  return (
    <section
      class={["chat-delegation__group", { "chat-delegation__group--failed": counts().failed > 0 }]}
    >
      <button
        type="button"
        class="chat-delegation__summary"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setExpanded(!open())}
      >
        <span
          class={[
            "chat-delegation__icon",
            { "chat-delegation__icon--done": settled() && !counts().failed && !counts().unknown },
          ]}
        >
          <Icon
            name={
              counts().failed ? "alertTriangle" : settled() && !counts().unknown ? "check" : "users"
            }
          />
        </span>
        <span class="chat-delegation__title">{title()}</span>
        <span class="chat-delegation__status">{status()}</span>
        <Show when={tasks().length === 1 && tasks()[0]!.runtimeMs != null}>
          <span class="chat-delegation__duration">
            {formatDurationCompact(tasks()[0]!.runtimeMs)}
          </span>
        </Show>
        <span class={["chat-delegation__chevron", { "chat-delegation__chevron--open": open() }]}>
          <Icon name="chevronDown" />
        </span>
      </button>
      <Show when={tasks().length > 5 && !settled()}>
        <div
          class="chat-delegation__progress"
          role="progressbar"
          aria-label={t("chat.toolCards.delegation.completedTasks")}
          aria-valuemin={0}
          aria-valuemax={tasks().length}
          aria-valuenow={counts().complete}
        >
          <span style={{ width: (100 * counts().complete) / tasks().length + "%" }} />
        </div>
      </Show>
      <Show when={open()}>
        <ul class="chat-delegation__tasks">
          <For each={visibleTasks()} keyed={(task) => task.runId}>
            {(task) => (
              <li class="chat-delegation__task">
                <span
                  class={[
                    "chat-delegation__icon",
                    {
                      "chat-delegation__icon--done": task().status === "done",
                      "chat-delegation__icon--failed": failed(task()),
                      "chat-delegation__icon--running": task().status === "running",
                    },
                  ]}
                >
                  <Icon name={icon(task())} />
                </span>
                <Show
                  when={task().listed}
                  fallback={
                    <span class="chat-delegation__name">
                      {task().label || t("chat.toolCards.delegation.task")}
                    </span>
                  }
                >
                  <button
                    type="button"
                    class="chat-delegation__name"
                    onClick={() => props.onOpen(task().childSessionKey)}
                  >
                    {task().label || t("chat.toolCards.delegation.task")}
                  </button>
                </Show>
                <span class="chat-delegation__status">
                  {t("chat.toolCards.delegation." + task().status)}
                </span>
                <span class="chat-delegation__duration">
                  {formatDurationCompact(task().runtimeMs) ?? ""}
                </span>
              </li>
            )}
          </For>
          <Show when={tasks().length > visibleTasks().length}>
            <li class="chat-delegation__status">
              {t("chat.toolCards.delegation.more", {
                count: String(tasks().length - visibleTasks().length),
              })}
            </li>
          </Show>
        </ul>
      </Show>
    </section>
  );
}
