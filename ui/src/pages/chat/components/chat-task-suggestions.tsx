import { createMemo, createSignal, createUniqueId, For, Show, onSettled } from "solid-js";
import type {
  ProjectRecord,
  TaskSuggestion,
  TaskSuggestionsAcceptParams,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";
import { isAbsolutePath } from "../../new-session/path.ts";
import "../../../styles/chat/composer-task-suggestions.css";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

export type TaskSuggestionStartMode = Extract<
  TaskSuggestionsAcceptParams["mode"],
  "local" | "worktree" | "session"
>;

export type TaskSuggestionAcceptance =
  | { phase: "starting" }
  | { phase: "started" }
  | {
      phase: "failed";
      error: string;
      repository?: { cwd: string; open: boolean; projects: ProjectRecord[] };
    };

export type ChatTaskSuggestionTrayProps = {
  taskSuggestions?: TaskSuggestion[];
  taskSuggestionCopiedIds?: ReadonlySet<string>;
  taskSuggestionAcceptance?: (taskId: string) => TaskSuggestionAcceptance | undefined;
  activeTaskSuggestionId?: string;
  taskSuggestionSwapDirection?: "next" | "previous";
  taskSuggestionSwapGeneration?: number;
  onNavigateTaskSuggestion?: (taskId: string, direction: "next" | "previous") => void;
  onTaskSuggestionNavigationMount?: (
    taskId: string,
    direction: "next" | "previous",
    button: HTMLButtonElement,
  ) => void;
  onCopyTaskSuggestionPrompt?: (suggestion: TaskSuggestion) => void;
  canAcceptTaskSuggestions?: boolean;
  canDismissTaskSuggestions?: boolean;
  onAcceptTaskSuggestion?: (
    suggestion: TaskSuggestion,
    mode: TaskSuggestionStartMode,
    cwd?: string,
  ) => void;
  onChangeTaskRepository?: (
    suggestion: TaskSuggestion,
    patch: { cwd?: string; open?: boolean },
  ) => void;
  onDismissTaskSuggestion?: (suggestion: TaskSuggestion) => void;
};

// Mirrors the TUI sanitizer to prevent directionality spoofing. This stays local
// because the Control UI cannot import core src/ modules.
function sanitizeTaskSuggestionText(text: string): string {
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function ChatTaskSuggestionTray(props: { view: ChatTaskSuggestionTrayProps }) {
  const suggestions = () => props.view.taskSuggestions ?? [];
  const activeId = createMemo(() =>
    suggestions().some((suggestion) => suggestion.id === props.view.activeTaskSuggestionId)
      ? props.view.activeTaskSuggestionId
      : suggestions()[0]?.id,
  );
  // Disclosure belongs to the tray, so paging through suggestions keeps the operator's choice.
  const [expanded, setExpanded] = createSignal(false);
  return (
    <Show when={suggestions().length > 0}>
      <div class="task-suggestions" aria-live="polite">
        <For each={suggestions()} keyed={(suggestion) => suggestion.id}>
          {(suggestion, index) => (
            // Only navigation generations replace cards; ordinary owner updates retain native state.
            <Show
              keyed
              when={`${suggestion().id}:${suggestion().id === activeId() ? (props.view.taskSuggestionSwapGeneration ?? 0) : "inactive"}`}
            >
              {(_key) => (
                <TaskSuggestionCard
                  suggestion={suggestion()}
                  index={index()}
                  count={suggestions().length}
                  active={suggestion().id === activeId()}
                  expanded={expanded()}
                  onToggle={() => setExpanded((open) => !open)}
                  view={props.view}
                />
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}

function TaskSuggestionCard(props: {
  suggestion: TaskSuggestion;
  index: number;
  count: number;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  view: ChatTaskSuggestionTrayProps;
}) {
  const detailsId = createUniqueId();
  const canAccept = () => props.view.canAcceptTaskSuggestions === true;
  const acceptance = () => props.view.taskSuggestionAcceptance?.(props.suggestion.id);
  const busy = () => acceptance()?.phase === "starting";
  const failure = () => {
    const value = acceptance();
    return value?.phase === "failed" ? value : undefined;
  };
  const repository = () => failure()?.repository;
  // A failed start needs its error and recovery in view, so failure keeps the card open.
  const open = () => props.expanded || Boolean(failure());
  const title = () => sanitizeTaskSuggestionText(props.suggestion.title);
  const cwd = () => sanitizeTaskSuggestionText(props.suggestion.cwd);
  const repoName = () => sanitizeTaskSuggestionText(pathDisplayName(cwd()));
  const label = () => t("chat.taskSuggestions.eyebrow", { repo: repoName() });
  const copied = () => props.view.taskSuggestionCopiedIds?.has(props.suggestion.id) === true;
  const copyLabel = () =>
    t(copied() ? "chat.taskSuggestions.promptCopied" : "chat.taskSuggestions.copyPrompt");
  const startLabel = () =>
    t(busy() ? "chat.taskSuggestions.starting" : "chat.taskSuggestions.startSession");
  // Native edits survive unrelated owner refreshes.
  const repositoryCwd = createMemo(() => repository()?.cwd ?? "");
  const pathRef = createScrollStateRef(
    (element, state) => element.toggleAttribute("data-overflow-right", !state.atEnd),
    { presented: () => props.active && open(), horizontal: true, content: cwd },
  );
  const accept = (mode: TaskSuggestionStartMode) => {
    if (!busy() && canAccept()) {
      props.view.onAcceptTaskSuggestion?.(props.suggestion, mode, undefined);
    }
  };

  /** One start action: a quiet text button in the closed row, the standard small
   *  primary button (as in the question panel) in the open footer. */
  function StartAction(startProps: { placement: "head" | "foot" }) {
    const id = createUniqueId();
    const primary = startProps.placement === "foot";
    const buttonClass = `btn btn--sm${primary ? " primary" : ""} task-suggestion__start`;
    return (
      <div class="task-suggestion__split" data-placement={startProps.placement}>
        <button
          class={`${buttonClass} task-suggestion__start--primary`}
          type="button"
          disabled={busy() || !canAccept()}
          aria-label={startLabel()}
          title={
            !canAccept()
              ? t("chat.taskSuggestions.adminRequired")
              : primary
                ? undefined
                : startLabel()
          }
          onClick={() => accept("local")}
        >
          {primary
            ? startLabel()
            : t(busy() ? "chat.taskSuggestions.starting" : "chat.taskSuggestions.start")}
        </button>
        <Menu
          id={`task-start-${id}`}
          placement="top-end"
          label={t("chat.taskSuggestions.startOptions")}
          disabled={busy() || !canAccept()}
          triggerClass={`${buttonClass} task-suggestion__start--options`}
          triggerAttributes={{ title: canAccept() ? "" : t("chat.taskSuggestions.adminRequired") }}
          trigger={<Icon name="chevronDown" />}
          items={[
            {
              id: "local",
              label: t("chat.taskSuggestions.startSession"),
              disabled: busy() || !canAccept(),
            },
            {
              id: "worktree",
              label: t("chat.taskSuggestions.startWorktree"),
              disabled: busy() || !canAccept(),
            },
            {
              id: "session",
              label: t("chat.taskSuggestions.startCurrentSession"),
              disabled: busy() || !canAccept(),
            },
          ]}
          onSelect={(item) => {
            if (item.id === "local" || item.id === "worktree" || item.id === "session") {
              accept(item.id);
            }
          }}
        />
      </div>
    );
  }

  return (
    <article
      class="task-suggestion"
      data-task-id={props.suggestion.id}
      data-expanded={open() ? "true" : "false"}
      data-failed={failure() ? "true" : undefined}
      data-swap-direction={props.active ? props.view.taskSuggestionSwapDirection : undefined}
      aria-label={label()}
      hidden={!props.active}
    >
      <div class="task-suggestion__head">
        <button
          class="task-suggestion__toggle"
          type="button"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={detailsId}
          disabled={Boolean(failure())}
          title={t(
            open()
              ? "chat.taskSuggestions.hideInstructions"
              : "chat.taskSuggestions.showInstructions",
          )}
          onClick={() => props.onToggle()}
        >
          <span class="task-suggestion__icon" aria-hidden="true" title={label()}>
            <Icon name={failure() ? "alertTriangle" : "lightbulb"} />
          </span>
          <span class="task-suggestion__heading">
            <span class="task-suggestion__title">{title()}</span>
            <span class="task-suggestion__repo" title={cwd()}>
              {repoName()}
            </span>
          </span>
          <Show when={!failure()}>
            <span class="task-suggestion__chevron" aria-hidden="true">
              <Icon name="chevronDown" />
            </span>
          </Show>
        </button>
        <div class="task-suggestion__head-actions">
          <Show when={props.count > 1}>
            <div class="task-suggestion__pager">
              <For each={["previous", "next"] as const}>
                {(direction) => {
                  let button: HTMLButtonElement | undefined;
                  onSettled(() => {
                    if (props.active && button) {
                      props.view.onTaskSuggestionNavigationMount?.(
                        props.suggestion.id,
                        direction,
                        button,
                      );
                    }
                  });
                  return (
                    <>
                      <Show when={direction === "next"}>
                        <span class="task-suggestion__position">
                          {props.index + 1}/{props.count}
                        </span>
                      </Show>
                      <button
                        ref={(element) => {
                          button = element;
                        }}
                        class="task-suggestion__icon-button task-suggestion__page"
                        type="button"
                        aria-label={t(
                          direction === "previous"
                            ? "chat.taskSuggestions.previous"
                            : "chat.taskSuggestions.next",
                        )}
                        data-task-prev={direction === "previous" ? "" : undefined}
                        data-task-next={direction === "next" ? "" : undefined}
                        onClick={() =>
                          props.view.onNavigateTaskSuggestion?.(props.suggestion.id, direction)
                        }
                      >
                        <Icon name={direction === "previous" ? "chevronLeft" : "chevronRight"} />
                      </button>
                    </>
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={!open()}>
            <StartAction placement="head" />
          </Show>
          <Show when={props.view.canDismissTaskSuggestions === true}>
            <button
              class="task-suggestion__icon-button task-suggestion__dismiss"
              type="button"
              disabled={busy()}
              aria-label={t("chat.taskSuggestions.dismiss", { title: title() })}
              title={t("chat.taskSuggestions.dismiss", { title: title() })}
              onClick={() => props.view.onDismissTaskSuggestion?.(props.suggestion)}
            >
              <Icon name="x" />
            </button>
          </Show>
        </div>
      </div>
      <div class="task-suggestion__details" id={detailsId} hidden={!open()}>
        <p class="task-suggestion__summary">{sanitizeTaskSuggestionText(props.suggestion.tldr)}</p>
        <Show when={repository()?.open}>
          <div class="task-suggestion__repository">
            <p>{t("chat.taskSuggestions.chooseRepositoryHelp")}</p>
            <label>
              <span>{t("chat.taskSuggestions.repositoryFolder")}</span>
              <input
                type="text"
                class="task-suggestion__repository-path"
                value={repositoryCwd()}
                disabled={!canAccept()}
                onInput={(event) =>
                  props.view.onChangeTaskRepository?.(props.suggestion, {
                    cwd: event.currentTarget.value,
                  })
                }
              />
            </label>
            <Show when={(repository()?.projects.length ?? 0) > 0}>
              <div class="task-suggestion__repository-list">
                <For each={repository()?.projects ?? []}>
                  {(project) => (
                    <button
                      type="button"
                      class="task-suggestion__repository-choice"
                      data-selected={
                        project.repoRoot && project.repoRoot === repositoryCwd().trim()
                          ? "true"
                          : undefined
                      }
                      disabled={!canAccept()}
                      title={project.repoRoot ?? ""}
                      onClick={() =>
                        props.view.onChangeTaskRepository?.(props.suggestion, {
                          cwd: project.repoRoot ?? "",
                        })
                      }
                    >
                      <Icon name="folder" />
                      <span>{project.displayName}</span>
                      <small>{project.repoRoot}</small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <div class="task-suggestion__prompt">
          <div class="task-suggestion__prompt-head">
            <Icon name="folder" />
            <code ref={pathRef} class="task-suggestion__path" title={cwd()}>
              {cwd()}
            </code>
            <button
              class="task-suggestion__icon-button task-suggestion__copy"
              type="button"
              aria-label={copyLabel()}
              title={copyLabel()}
              onClick={() => props.view.onCopyTaskSuggestionPrompt?.(props.suggestion)}
            >
              <Icon name={copied() ? "check" : "copy"} />
            </button>
          </div>
          <div class="task-suggestion__prompt-text">
            {sanitizeTaskSuggestionText(props.suggestion.prompt)}
          </div>
        </div>
      </div>
      <Show when={open()}>
        <div class="task-suggestion__foot">
          <Show when={failure()} fallback={<StartAction placement="foot" />}>
            {(value) => (
              <>
                <span class="task-suggestion__error" role="alert">
                  {repository() ? undefined : t("chat.taskSuggestions.startUnconfirmed")}{" "}
                  {value().error}
                </span>
                <Show when={repository()?.open}>
                  <button
                    type="button"
                    class="btn btn--sm task-suggestion__secondary"
                    onClick={() =>
                      props.view.onChangeTaskRepository?.(props.suggestion, { open: false })
                    }
                  >
                    {t("common.cancel")}
                  </button>
                </Show>
                <button
                  class="btn btn--sm primary task-suggestion__start task-suggestion__retry"
                  type="button"
                  disabled={
                    !canAccept() ||
                    Boolean(repository()?.open && !isAbsolutePath(repositoryCwd().trim()))
                  }
                  onClick={() => {
                    const target = repository();
                    if (!target) {
                      accept("local");
                    } else if (!target.open) {
                      props.view.onChangeTaskRepository?.(props.suggestion, { open: true });
                    } else if (canAccept() && isAbsolutePath(target.cwd.trim())) {
                      props.view.onAcceptTaskSuggestion?.(
                        props.suggestion,
                        "worktree",
                        target.cwd.trim(),
                      );
                    }
                  }}
                >
                  {repository()
                    ? t(
                        repository()?.open
                          ? "chat.taskSuggestions.startWorktree"
                          : "chat.taskSuggestions.chooseRepository",
                      )
                    : t("common.retry")}
                </button>
              </>
            )}
          </Show>
        </div>
      </Show>
    </article>
  );
}
