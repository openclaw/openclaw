// Chat UI cards for model-proposed follow-up tasks.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import type {
  ProjectRecord,
  TaskSuggestion,
  TaskSuggestionsAcceptParams,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { repoName } from "../../../lib/session-display.ts";
import { isAbsolutePath } from "../../new-session/path.ts";

export type TaskSuggestionStartMode = Extract<
  TaskSuggestionsAcceptParams["mode"],
  "local" | "worktree" | "session"
>;

export type TaskSuggestionAcceptance =
  | { phase: "starting" }
  | { phase: "started"; sessionKey: string; href: string }
  | {
      phase: "failed";
      error: string;
      repository?: { cwd: string; open: boolean; projects: ProjectRecord[] };
    };

export type ChatTaskSuggestionTrayProps = {
  taskSuggestions?: TaskSuggestion[];
  taskSuggestionBusyIds?: ReadonlySet<string>;
  taskSuggestionCopiedIds?: ReadonlySet<string>;
  taskSuggestionAcceptance?: (taskId: string) => TaskSuggestionAcceptance | undefined;
  onOpenTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  canOpenTaskSuggestions?: boolean;
  activeTaskSuggestionId?: string;
  taskSuggestionSwapDirection?: "next" | "previous";
  taskSuggestionSwapGeneration?: number;
  onNavigateTaskSuggestion?: (taskId: string, direction: "next" | "previous") => void;
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

export function renderChatTaskSuggestionTray(props: ChatTaskSuggestionTrayProps) {
  return renderChatTaskSuggestions({
    suggestions: props.taskSuggestions ?? [],
    busyIds: props.taskSuggestionBusyIds ?? new Set(),
    copiedIds: props.taskSuggestionCopiedIds ?? new Set(),
    acceptanceFor: props.taskSuggestionAcceptance,
    onOpen: props.onOpenTaskSuggestion,
    canOpen: props.canOpenTaskSuggestions === true,
    activeId: props.activeTaskSuggestionId,
    swapDirection: props.taskSuggestionSwapDirection,
    swapGeneration: props.taskSuggestionSwapGeneration ?? 0,
    onCopyPrompt: (suggestion) => props.onCopyTaskSuggestionPrompt?.(suggestion),
    canAccept: props.canAcceptTaskSuggestions === true,
    canDismiss: props.canDismissTaskSuggestions === true,
    onAccept: (suggestion, mode, cwd) => props.onAcceptTaskSuggestion?.(suggestion, mode, cwd),
    onChangeRepository: (suggestion, patch) => props.onChangeTaskRepository?.(suggestion, patch),
    onDismiss: (suggestion) => props.onDismissTaskSuggestion?.(suggestion),
    onNavigate: (taskId, direction) => props.onNavigateTaskSuggestion?.(taskId, direction),
  });
}

// Mirrors the TUI sanitizer to prevent directionality spoofing. This stays local
// because the Control UI cannot import core src/ modules.
function sanitizeTaskSuggestionText(text: string): string {
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function updateTaskSuggestionPathFade(element: Element): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const hasContentToRight = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
  element.toggleAttribute("data-overflow-right", hasContentToRight);
}

function renderChatTaskSuggestions(props: {
  suggestions: TaskSuggestion[];
  busyIds: ReadonlySet<string>;
  canAccept: boolean;
  canDismiss: boolean;
  onAccept: (suggestion: TaskSuggestion, mode: TaskSuggestionStartMode, cwd?: string) => void;
  onChangeRepository: (suggestion: TaskSuggestion, patch: { cwd?: string; open?: boolean }) => void;
  onDismiss: (suggestion: TaskSuggestion) => void;
  onCopyPrompt: (suggestion: TaskSuggestion) => void;
  copiedIds: ReadonlySet<string>;
  acceptanceFor?: (taskId: string) => TaskSuggestionAcceptance | undefined;
  onOpen?: (suggestion: TaskSuggestion) => void;
  canOpen: boolean;
  activeId?: string;
  swapDirection?: "next" | "previous";
  swapGeneration: number;
  onNavigate: (taskId: string, direction: "next" | "previous") => void;
}) {
  if (props.suggestions.length === 0) {
    return nothing;
  }
  const multiple = props.suggestions.length > 1;
  const activeId = props.suggestions.some((suggestion) => suggestion.id === props.activeId)
    ? props.activeId
    : props.suggestions[0]?.id;
  return html`
    <div class="task-suggestions ${multiple ? "task-suggestions--stack" : ""}" aria-live="polite">
      ${props.suggestions.map((suggestion, index) => {
        const busy = props.busyIds.has(suggestion.id);
        const acceptance = props.acceptanceFor?.(suggestion.id);
        const repository = acceptance?.phase === "failed" ? acceptance.repository : undefined;
        const title = sanitizeTaskSuggestionText(suggestion.title);
        const tldr = sanitizeTaskSuggestionText(suggestion.tldr);
        const cwd = sanitizeTaskSuggestionText(suggestion.cwd);
        const prompt = sanitizeTaskSuggestionText(suggestion.prompt);
        const repo = sanitizeTaskSuggestionText(repoName(cwd));
        const copied = props.copiedIds.has(suggestion.id);
        const copyLabel = copied
          ? t("chat.taskSuggestions.promptCopied")
          : t("chat.taskSuggestions.copyPrompt");
        const accept = (mode: TaskSuggestionStartMode) => {
          if (!busy && props.canAccept) {
            props.onAccept(suggestion, mode);
          }
        };
        const active = suggestion.id === activeId;
        const card = html`
          <article
            class="task-suggestion"
            data-task-id=${suggestion.id}
            data-swap-direction=${active && props.swapDirection ? props.swapDirection : nothing}
            ?hidden=${!active}
          >
            <header class="task-suggestion__header">
              <div class="task-suggestion__eyebrow" title=${cwd}>
                ${t("chat.taskSuggestions.eyebrow", { repo })}
                ${
                  multiple
                    ? html`<span class="task-suggestion__position"
                        >${index + 1} / ${props.suggestions.length}</span
                      >`
                    : nothing
                }
              </div>
              <div class="task-suggestion__header-actions">
                <button
                  class="task-suggestion__header-action task-suggestion__copy"
                  type="button"
                  aria-label=${copyLabel}
                  title=${copyLabel}
                  @click=${() => props.onCopyPrompt(suggestion)}
                >
                  ${copied ? icons.check : icons.copy}
                </button>
                ${
                  multiple
                    ? html`
                        <button
                          class="task-suggestion__header-action"
                          type="button"
                          aria-label=${t("chat.taskSuggestions.previous")}
                          data-task-prev
                          @click=${() => props.onNavigate(suggestion.id, "previous")}
                        >
                          ${icons.chevronLeft}
                        </button>
                        <button
                          class="task-suggestion__header-action"
                          type="button"
                          aria-label=${t("chat.taskSuggestions.next")}
                          data-task-next
                          @click=${() => props.onNavigate(suggestion.id, "next")}
                        >
                          ${icons.chevronRight}
                        </button>
                      `
                    : nothing
                }
                ${
                  props.canDismiss || acceptance?.phase === "started"
                    ? html`
                        <button
                          class="task-suggestion__header-action task-suggestion__dismiss"
                          type="button"
                          ?disabled=${busy || (acceptance?.phase === "started" && !props.canOpen)}
                          aria-label=${t("chat.taskSuggestions.dismiss", { title })}
                          @click=${() => props.onDismiss(suggestion)}
                        >
                          ${icons.x}
                        </button>
                      `
                    : nothing
                }
              </div>
            </header>
            <div class="task-suggestion__body">
              <div class="task-suggestion__title">${title}</div>
              <div class="task-suggestion__summary">${tldr}</div>
              <details class="task-suggestion__instructions" ?open=${Boolean(acceptance) || busy}>
                <summary>
                  <span class="task-suggestion__instructions-chevron" aria-hidden="true"
                    >${icons.chevronRight}</span
                  >
                  <span class="task-suggestion__show"
                    >${t("chat.taskSuggestions.showInstructions")}</span
                  >
                  <span class="task-suggestion__hide"
                    >${t("chat.taskSuggestions.hideInstructions")}</span
                  >
                </summary>
                <div class="task-suggestion__instruction-body">
                  <code
                    ${ref((element) => {
                      if (element) {
                        requestAnimationFrame(() => updateTaskSuggestionPathFade(element));
                      }
                    })}
                    @scroll=${(event: Event) =>
                      updateTaskSuggestionPathFade(event.currentTarget as Element)}
                    >${cwd}</code
                  >
                  <pre>${prompt}</pre>
                </div>
              </details>
              ${
                acceptance?.phase === "started"
                  ? html`<p class="task-suggestion__summary" role="status">
                      ${t("chat.taskSuggestions.started")}
                    </p>`
                  : acceptance?.phase === "failed"
                    ? html`<div class="callout danger" role="alert">
                        <span
                          >${repository ? nothing : t("chat.taskSuggestions.startUnconfirmed")}
                          ${acceptance.error}</span
                        >
                      </div>`
                    : nothing
              }
              ${
                repository?.open
                  ? html`
                      <div class="task-suggestion__repository">
                        <p>${t("chat.taskSuggestions.chooseRepositoryHelp")}</p>
                        <label>
                          <span>${t("chat.taskSuggestions.repositoryFolder")}</span>
                          <input
                            type="text"
                            class="task-suggestion__repository-path"
                            .value=${repository.cwd}
                            ?disabled=${!props.canAccept}
                            @input=${(event: Event) => {
                              // SAFETY: This handler is attached directly to the repository input.
                              const input = event.currentTarget as HTMLInputElement;
                              props.onChangeRepository(suggestion, { cwd: input.value });
                            }}
                          />
                        </label>
                        ${repository.projects.map(
                          (project) => html`
                            <button
                              type="button"
                              class="btn task-suggestion__repository-choice"
                              ?disabled=${!props.canAccept}
                              title=${project.repoRoot ?? ""}
                              @click=${() => props.onChangeRepository(suggestion, { cwd: project.repoRoot ?? "" })}
                            >
                              ${project.displayName}<small>${project.repoRoot}</small>
                            </button>
                          `,
                        )}
                        <button
                          type="button"
                          class="btn"
                          @click=${() => props.onChangeRepository(suggestion, { open: false })}
                        >
                          ${t("common.cancel")}
                        </button>
                      </div>
                    `
                  : nothing
              }
            </div>
            <div class="task-suggestion__actions">
              ${
                acceptance?.phase === "started"
                  ? html`<a
                      class="btn task-suggestion__start task-suggestion__open"
                      href=${props.canOpen ? acceptance.href : nothing}
                      aria-disabled=${props.canOpen ? nothing : "true"}
                      tabindex=${props.canOpen ? 0 : -1}
                      @click=${(event: MouseEvent) => {
                        if (!props.canOpen) {
                          event.preventDefault();
                        } else if (props.onOpen && shouldHandleNavigationClick(event)) {
                          event.preventDefault();
                          props.onOpen(suggestion);
                        }
                      }}
                      >${t("sessionsView.openSession")}</a
                    >`
                  : acceptance?.phase === "failed"
                    ? html`<button
                        class="btn task-suggestion__start task-suggestion__retry"
                        type="button"
                        ?disabled=${!props.canAccept || Boolean(repository?.open && !isAbsolutePath(repository.cwd.trim()))}
                        @click=${() => {
                          if (repository) {
                            if (!repository.open) {
                              props.onChangeRepository(suggestion, { open: true });
                            } else if (props.canAccept && isAbsolutePath(repository.cwd.trim())) {
                              props.onAccept(suggestion, "worktree", repository.cwd.trim());
                            }
                          } else {
                            accept("local");
                          }
                        }}
                      >
                        ${repository ? t(repository.open ? "chat.taskSuggestions.startWorktree" : "chat.taskSuggestions.chooseRepository") : t("common.retry")}
                      </button>`
                    : html`
                        <button
                          class="btn task-suggestion__start task-suggestion__start--primary"
                          type="button"
                          ?disabled=${busy || !props.canAccept}
                          title=${props.canAccept ? "" : t("chat.taskSuggestions.adminRequired")}
                          @click=${() => accept("local")}
                        >
                          ${icons.play}
                          ${
                            busy
                              ? t("chat.taskSuggestions.starting")
                              : t("chat.taskSuggestions.startSession")
                          }
                        </button>
                        <wa-dropdown
                          placement="bottom-end"
                          ?disabled=${busy || !props.canAccept}
                          @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
                            const mode = event.detail.item.value;
                            if (mode === "local" || mode === "worktree" || mode === "session") {
                              accept(mode);
                            }
                          }}
                        >
                          <button
                            slot="trigger"
                            class="btn task-suggestion__start task-suggestion__start--options"
                            type="button"
                            ?disabled=${busy || !props.canAccept}
                            aria-label=${t("chat.taskSuggestions.startOptions")}
                            title=${props.canAccept ? "" : t("chat.taskSuggestions.adminRequired")}
                          >
                            ${icons.chevronDown}
                          </button>
                          <wa-dropdown-item value="local" ?disabled=${busy || !props.canAccept}>
                            ${t("chat.taskSuggestions.startSession")}
                          </wa-dropdown-item>
                          <wa-dropdown-item value="worktree" ?disabled=${busy || !props.canAccept}>
                            ${t("chat.taskSuggestions.startWorktree")}
                          </wa-dropdown-item>
                          <wa-dropdown-item value="session" ?disabled=${busy || !props.canAccept}>
                            ${t("chat.taskSuggestions.startCurrentSession")}
                          </wa-dropdown-item>
                        </wa-dropdown>
                      `
              }
            </div>
          </article>
        `;
        // A fresh keyed card restarts the directional entrance even when this
        // task and direction were used before; ordinary rerenders retain it.
        return active
          ? keyed(`${suggestion.id}:${props.swapGeneration}`, card)
          : keyed(`${suggestion.id}:inactive`, card);
      })}
    </div>
  `;
}
