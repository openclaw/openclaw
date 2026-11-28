import { createMemo, createUniqueId, For, Show, onSettled } from "solid-js";
import type {
  ProjectRecord,
  TaskSuggestion,
  TaskSuggestionsAcceptParams,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { Menu, type MenuItem } from "../../../components/solid/menu.tsx";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";
import { isAbsolutePath } from "../../new-session/path.ts";

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
      repository?: { cwd: string; open: boolean };
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
  /** Registered projects with a repository; read only by cards that need a worktree source. */
  taskRepositoryProjects?: () => {
    status: "loading" | "ready" | "failed";
    projects: readonly ProjectRecord[];
  };
  taskSuggestionBlockedReason?: string;
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
  return (
    <Show when={suggestions().length > 0}>
      <div
        class={["task-suggestions", { "task-suggestions--stack": suggestions().length > 1 }]}
        aria-live="polite"
      >
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
  view: ChatTaskSuggestionTrayProps;
}) {
  const canAccept = () => props.view.canAcceptTaskSuggestions === true;
  const acceptance = () => props.view.taskSuggestionAcceptance?.(props.suggestion.id);
  const busy = () => acceptance()?.phase === "starting";
  const failure = () => {
    const value = acceptance();
    return value?.phase === "failed" ? value : undefined;
  };
  const repository = () => failure()?.repository;
  const catalog = () => props.view.taskRepositoryProjects?.();
  const projects = () => catalog()?.projects ?? [];
  const title = () => sanitizeTaskSuggestionText(props.suggestion.title);
  const cwd = () => sanitizeTaskSuggestionText(props.suggestion.cwd);
  const copyLabel = () =>
    t(
      props.view.taskSuggestionCopiedIds?.has(props.suggestion.id)
        ? "chat.taskSuggestions.promptCopied"
        : "chat.taskSuggestions.copyPrompt",
    );
  // Native edits and manual disclosure state survive unrelated owner refreshes.
  const repositoryCwd = createMemo(() => repository()?.cwd ?? "");
  // The card names the project picked in the chooser; typed paths leave it unchanged.
  const location = () => {
    const picked = repository()?.open
      ? projects().find((project) => project.repoRoot === repositoryCwd())?.repoRoot
      : undefined;
    return picked ? sanitizeTaskSuggestionText(picked) : cwd();
  };
  // Keep the repository chooser in view; preserved instructions stay one click away.
  const instructionsOpen = createMemo(() => Boolean(acceptance()) && !repository()?.open);
  const pathRef = createScrollStateRef(
    (element, state) => element.toggleAttribute("data-overflow-right", !state.atEnd),
    { presented: () => props.active, horizontal: true, content: cwd },
  );
  const accept = (mode: TaskSuggestionStartMode) => {
    if (!busy() && canAccept()) {
      props.view.onAcceptTaskSuggestion?.(props.suggestion, mode, undefined);
    }
  };

  // A folder outside a repository can still start in a worktree of a registered project.
  // Without a project catalog, the plain item keeps the repository chooser reachable.
  const worktreeItem = (): MenuItem => {
    const item = {
      id: "worktree",
      label: t("chat.taskSuggestions.startWorktree"),
      disabled: busy() || !canAccept(),
    };
    if (props.suggestion.worktreeSource !== false || catalog()?.status === "failed") {
      return item;
    }
    return {
      ...item,
      details: <Icon name="chevronRight" />,
      // Projects first; the last row opens the chooser for any other repository path.
      children: () => [
        ...(projects().length > 0
          ? projects().map((project) => ({
              id: `worktree:${project.id}`,
              label: project.displayName,
              attributes: { title: project.repoRoot ?? "" },
            }))
          : catalog()?.status === "ready"
            ? []
            : [{ id: "worktree:loading", label: t("common.loading"), disabled: true }]),
        { id: "worktree", label: t("chat.taskSuggestions.chooseRepository") },
      ],
    };
  };

  function TaskStartMenu() {
    const id = createUniqueId();
    return (
      <Menu
        id={`task-start-${id}`}
        placement="bottom-end"
        label={t("chat.taskSuggestions.startOptions")}
        disabled={busy() || !canAccept()}
        triggerClass="btn task-suggestion__start task-suggestion__start--options"
        triggerAttributes={{ title: canAccept() ? "" : props.view.taskSuggestionBlockedReason }}
        trigger={<Icon name="chevronDown" />}
        items={[
          {
            id: "local",
            label: t("chat.taskSuggestions.startSession"),
            disabled: busy() || !canAccept(),
          },
          worktreeItem(),
          {
            id: "session",
            label: t("chat.taskSuggestions.startCurrentSession"),
            disabled: busy() || !canAccept(),
          },
        ]}
        onSelect={(item) => {
          if (item.id === "local" || item.id === "worktree" || item.id === "session") {
            accept(item.id);
            return;
          }
          const project = projects().find((entry) => `worktree:${entry.id}` === item.id);
          if (project?.repoRoot && !busy() && canAccept()) {
            props.view.onAcceptTaskSuggestion?.(props.suggestion, "worktree", project.repoRoot);
          }
        }}
      />
    );
  }
  return (
    <article
      class="task-suggestion"
      data-task-id={props.suggestion.id}
      data-swap-direction={props.active ? props.view.taskSuggestionSwapDirection : undefined}
      hidden={!props.active}
    >
      <header class="task-suggestion__header">
        <div class="task-suggestion__eyebrow" title={location()}>
          {t("chat.taskSuggestions.eyebrow", {
            repo: sanitizeTaskSuggestionText(pathDisplayName(location())),
          })}
          <Show when={props.count > 1}>
            <span class="task-suggestion__position">
              {props.index + 1} / {props.count}
            </span>
          </Show>
        </div>
        <div class="task-suggestion__header-actions">
          <button
            class="task-suggestion__header-action task-suggestion__copy"
            type="button"
            aria-label={copyLabel()}
            title={copyLabel()}
            onClick={() => props.view.onCopyTaskSuggestionPrompt?.(props.suggestion)}
          >
            <Icon
              name={props.view.taskSuggestionCopiedIds?.has(props.suggestion.id) ? "check" : "copy"}
            />
          </button>
          <Show when={props.count > 1}>
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
                  <button
                    ref={(element) => {
                      button = element;
                    }}
                    class="task-suggestion__header-action"
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
                );
              }}
            </For>
          </Show>
          <Show when={props.view.canDismissTaskSuggestions === true}>
            <button
              class="task-suggestion__header-action task-suggestion__dismiss"
              type="button"
              disabled={busy()}
              aria-label={t("chat.taskSuggestions.dismiss", { title: title() })}
              onClick={() => props.view.onDismissTaskSuggestion?.(props.suggestion)}
            >
              <Icon name="x" />
            </button>
          </Show>
        </div>
      </header>
      <div class="task-suggestion__body">
        <div class="task-suggestion__title">{title()}</div>
        <div class="task-suggestion__summary">
          {sanitizeTaskSuggestionText(props.suggestion.tldr)}
        </div>
        <Show when={!repository()?.open && failure()}>
          {(value) => (
            <InlineAlert tone="danger" role="alert">
              <span>
                {repository() ? undefined : t("chat.taskSuggestions.startUnconfirmed")}{" "}
                {value().error}
              </span>
            </InlineAlert>
          )}
        </Show>
        <Show when={repository()?.open}>
          {(_open) => {
            let chooser: HTMLDivElement | undefined;
            // Short trays scroll the card body; bring the chooser into view when it opens.
            onSettled(() => chooser?.scrollIntoView({ block: "nearest" }));
            return (
              <div
                class="task-suggestion__repository"
                ref={(element) => {
                  chooser = element;
                }}
              >
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
                <For each={projects()}>
                  {(project) => (
                    <button
                      type="button"
                      class="btn task-suggestion__repository-choice"
                      disabled={!canAccept()}
                      title={project.repoRoot ?? ""}
                      onClick={() =>
                        props.view.onChangeTaskRepository?.(props.suggestion, {
                          cwd: project.repoRoot ?? "",
                        })
                      }
                    >
                      {project.displayName}
                      <small>{project.repoRoot}</small>
                    </button>
                  )}
                </For>
              </div>
            );
          }}
        </Show>
        <details class="task-suggestion__instructions" open={instructionsOpen()}>
          <summary>
            <span class="task-suggestion__instructions-chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
            <span class="task-suggestion__show">{t("chat.taskSuggestions.showInstructions")}</span>
            <span class="task-suggestion__hide">{t("chat.taskSuggestions.hideInstructions")}</span>
          </summary>
          <div class="task-suggestion__instruction-body">
            <code ref={pathRef}>{cwd()}</code>
            <pre>{sanitizeTaskSuggestionText(props.suggestion.prompt)}</pre>
          </div>
        </details>
      </div>
      <div class="task-suggestion__actions">
        <Show
          when={failure()}
          fallback={
            <>
              <button
                class="btn task-suggestion__start task-suggestion__start--primary"
                type="button"
                disabled={busy() || !canAccept()}
                title={canAccept() ? "" : props.view.taskSuggestionBlockedReason}
                onClick={() => accept("local")}
              >
                <Icon name="play" />
                {t(busy() ? "chat.taskSuggestions.starting" : "chat.taskSuggestions.startSession")}
              </button>
              <TaskStartMenu />
            </>
          }
        >
          <Show when={repository()?.open}>
            <button
              type="button"
              class="btn task-suggestion__cancel"
              onClick={() => props.view.onChangeTaskRepository?.(props.suggestion, { open: false })}
            >
              {t("common.cancel")}
            </button>
          </Show>
          <button
            class="btn task-suggestion__start task-suggestion__retry"
            type="button"
            disabled={
              !canAccept() || Boolean(repository()?.open && !isAbsolutePath(repositoryCwd().trim()))
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
        </Show>
      </div>
    </article>
  );
}
