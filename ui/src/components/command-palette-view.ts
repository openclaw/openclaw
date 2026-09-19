import { html, nothing } from "lit";
import type { GatewayAgentRow } from "../api/types.ts";
import { pathForAgentPanel, type RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../i18n/locales/en-command-palette.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import type { PaletteSessionDraft } from "../pages/new-session/palette-session-draft.ts";
import {
  commandPaletteCategoryLabel,
  filterCommandPaletteItems,
  type CommandPaletteItem,
} from "./command-palette-catalog-search.ts";
import { COMMAND_PALETTE_DIALOG_STYLE } from "./command-palette-contract.ts";
import { COMMAND_PALETTE_INPUT_ID, renderCommandPaletteInput } from "./command-palette-input.ts";
import { renderCommandPaletteResult } from "./command-palette-result.ts";
import { SESSION_ACTION_PREFIX } from "./command-palette-session-search.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";
import "./tooltip.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
} from "./panel-toggle-contract.ts";

registerCommandPaletteEnglish();

type PaletteItem = CommandPaletteItem;
export type PaletteFilter = "all" | "sessions" | "messages";

type CommandPaletteProps = {
  basePath: string;
  open: boolean;
  query: string;
  activeId: string | null;
  filter: PaletteFilter;
  onFilterChange: (filter: PaletteFilter) => void;
  agents: readonly GatewayAgentRow[];
  agentIdentity?: AgentIdentityCapability;
  defaultAgentId: string;
  sessionItems: readonly PaletteItem[];
  catalogItems: readonly PaletteItem[];
  modelSearchError: string | null;
  sessionSearchPending: boolean;
  searchLimitReached: boolean;
  catalogSearchPending: boolean;
  sessionSearchFailed: boolean;
  sessionSearchPartial: boolean;
  sessionSearchIndexing: boolean;
  archivedTranscriptsExcluded: number;
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIdChange: (id: string) => void;
  onNavigate?: ApplicationContext["navigate"];
  onSelectSession?: (sessionKey: string) => void;
  onSlashCommand?: (command: string) => void;
  desktopAvailable: boolean;
  custodianAvailable: boolean;
  onInputRef: (element: Element | undefined) => void;
  draft: PaletteSessionDraft;
};

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

const paletteInputId = COMMAND_PALETTE_INPUT_ID;
const paletteListboxId = "cmd-palette-listbox";

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (props.draft.submitting) {
    return;
  }
  if (item.action.startsWith("nav:")) {
    // SAFETY: the palette catalog builds every nav: action from a RouteId value.
    const routeId = item.action.slice(4) as RouteId;
    if (item.agentId) {
      props.onNavigate?.(routeId, {
        pathname: pathForAgentPanel(item.agentId, null, props.basePath),
      });
    } else if (item.search || item.hash) {
      props.onNavigate?.(routeId, { search: item.search, hash: item.hash });
    } else {
      props.onNavigate?.(routeId);
    }
  } else if (item.action.startsWith(SESSION_ACTION_PREFIX)) {
    props.onSelectSession?.(item.action.slice(SESSION_ACTION_PREFIX.length));
  } else if (item.action === "panel:desktop") {
    window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else if (item.action === "panel:custodian") {
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else {
    props.onSlashCommand?.(item.action);
  }
  props.onToggle();
}

function closePalette(props: CommandPaletteProps) {
  props.onToggle();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(
  event: KeyboardEvent,
  props: CommandPaletteProps,
  items: PaletteItem[],
  activeIndex: number,
) {
  if (event.defaultPrevented) {
    return;
  }
  if (event.isComposing || event.keyCode === 229) {
    event.stopPropagation();
    return;
  }
  // Picker controls keep their own Enter, arrows, and Escape. Only the shared
  // prompt field turns a key into palette navigation or background creation.
  if (!(event.target instanceof HTMLTextAreaElement) || event.target.id !== paletteInputId) {
    return;
  }
  if (event.key === "Enter" && event.repeat) {
    event.preventDefault();
    return;
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, event)) {
    event.preventDefault();
    event.stopPropagation();
    void props.draft.submit();
    return;
  }
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePalette(props);
    return;
  }
  if (props.draft.submitting) {
    return;
  }
  if (event.key === "Enter") {
    // No matches never turns Enter into Send (or a hidden blank line).
    event.preventDefault();
    const item = items[activeIndex];
    if (item) {
      selectItem(item, props);
    }
    return;
  }
  if (
    items.length === 0 ||
    props.query.includes("\n") ||
    (event.key !== "ArrowDown" && event.key !== "ArrowUp")
  ) {
    return;
  }
  event.preventDefault();
  const direction = event.key === "ArrowDown" ? 1 : -1;
  props.onActiveIdChange(items[(activeIndex + direction + items.length) % items.length]!.id);
  scrollActiveIntoView();
}

function getOptionId(index: number): string {
  return `cmd-palette-option-${index}`;
}

export function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }
  const matches = filterCommandPaletteItems({
    ...props,
    includeSlashCommands: Boolean(props.onSlashCommand),
  });
  const matchesFilter = (item: PaletteItem, filter: PaletteFilter) =>
    filter === "all" || item.category === (filter === "sessions" ? "chats" : "messages");
  const grouped = groupItems(matches.filter((item) => matchesFilter(item, props.filter)));
  const notices = [
    props.sessionSearchFailed
      ? t("palette.searchFailed")
      : props.sessionSearchIndexing
        ? t("palette.searchIndexing")
        : props.sessionSearchPartial
          ? t("palette.searchPartial")
          : null,
    props.archivedTranscriptsExcluded > 0
      ? t("sessionsView.transcriptSearchArchivedExcluded", {
          count: String(props.archivedTranscriptsExcluded),
        })
      : null,
  ].filter((notice): notice is string => Boolean(notice));
  const items = grouped.flatMap(([, entries]) => entries);
  // Preserve explicit selection through transient result changes, but only
  // highlight and execute current rows; an absent choice selects the first row.
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === props.activeId),
  );
  const activeOptionId = items[activeIndex] ? getOptionId(activeIndex) : undefined;
  const paletteLabel = t("palette.placeholder");
  const startLabel = t(props.draft.submitting ? "palette.startingSession" : "palette.startSession");
  const startDisabled = !props.query.trim() || !props.draft.canSubmit;
  const startReason = props.query.trim() ? props.draft.disabledReason : t("palette.promptRequired");
  const startShortcut = formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter);
  const searchSettled =
    Boolean(props.query.trim()) &&
    !props.sessionSearchPending &&
    !props.catalogSearchPending &&
    !props.searchLimitReached &&
    !props.modelSearchError &&
    !props.sessionSearchFailed &&
    !props.sessionSearchPartial &&
    !props.sessionSearchIndexing &&
    props.archivedTranscriptsExcluded === 0;

  return html`
    <openclaw-modal-dialog
      class="cmd-palette-overlay palette"
      label=${paletteLabel}
      style=${COMMAND_PALETTE_DIALOG_STYLE}
      @modal-cancel=${(event: Event) => {
        if (props.draft.submitting) {
          event.preventDefault();
          return;
        }
        closePalette(props);
      }}
    >
      <div
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props, items, activeIndex)}
      >
        ${renderCommandPaletteInput({
          value: props.query,
          placeholder: paletteLabel,
          onInputRef: props.onInputRef,
          onValueChange: props.onQueryChange,
          disabled: props.draft.submitting,
          readOnly: props.draft.messageLocked,
          controls: paletteListboxId,
          activeDescendant: activeOptionId,
          describedBy: "cmd-palette-keys",
          actions: html`
            <openclaw-tooltip content=${startReason ?? t("palette.startSessionBackground")}>
              <button
                type="button"
                class="cmd-palette__create"
                aria-label=${t("palette.startSessionBackground")}
                aria-busy=${String(props.draft.submitting)}
                ?disabled=${startDisabled}
                @click=${() => void props.draft.submit()}
              >
                ${startLabel}<kbd>${startShortcut}</kbd>
              </button>
            </openclaw-tooltip>
            ${props.draft.renderControls()}
          `,
        })}
        ${
          props.query.trim() && props.onSelectSession
            ? html`<div
                class="cmd-palette__filters"
                role="group"
                aria-label=${t("palette.filterLabel")}
              >
                ${(["all", "sessions", "messages"] as const).map((filter) => html`<button type="button" class="cmd-palette__filter" aria-pressed=${props.filter === filter ? "true" : "false"} @click=${() => props.onFilterChange(filter)}>${t(`palette.filters.${filter}`)}<span>${matches.filter((item) => matchesFilter(item, filter)).length}</span></button>`)}
              </div>`
            : nothing
        }
        ${
          props.sessionSearchPending || props.catalogSearchPending
            ? html`<div class="cmd-palette__empty" role="status">
                ${t(props.sessionSearchPending ? "palette.searchingSessions" : "palette.searchingCommands")}
              </div>`
            : nothing
        }
        <div
          id=${paletteListboxId}
          class="cmd-palette__results"
          ?hidden=${items.length === 0}
          role="listbox"
          aria-busy=${props.sessionSearchPending || props.catalogSearchPending ? "true" : "false"}
        >
          ${grouped.map(
            ([category, groupedItems]) => html`
              <div class="cmd-palette__group-label">
                ${commandPaletteCategoryLabel(category)}<span class="cmd-palette__group-count"
                  >${groupedItems.length}</span
                >
              </div>
              ${groupedItems.map((item) => {
                const globalIndex = items.indexOf(item);
                const isActive = globalIndex === activeIndex;
                const agentId = item.session
                  ? resolveUiSessionRowAgentId(item.session, props.defaultAgentId)
                  : item.agentId;
                const agent = agentId
                  ? (props.agents.find((row) => row.id === agentId) ?? { id: agentId })
                  : undefined;
                return html`
                  <div
                    id=${getOptionId(globalIndex)}
                    class="cmd-palette__item ${item.session ? "cmd-palette__item--session" : ""} ${isActive ? "cmd-palette__item--active" : ""}"
                    role="option"
                    aria-selected=${isActive ? "true" : "false"}
                    aria-disabled=${props.draft.submitting ? "true" : nothing}
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      selectItem(item, props);
                    }}
                    @mouseenter=${() => props.onActiveIdChange(item.id)}
                  >
                    ${renderCommandPaletteResult(item, props.query, agent, props.agentIdentity?.get(agentId))}
                  </div>
                `;
              })}
            `,
          )}
        </div>
        ${props.modelSearchError ? html`<div class="cmd-palette__source-error" role="status">${props.modelSearchError}</div>` : nothing}
        ${notices.map((notice) => html`<div class="cmd-palette__source-error" role="status">${notice}</div>`)}
        ${
          props.searchLimitReached
            ? html`<div class="cmd-palette__empty" role="status">${t("palette.longPrompt")}</div>`
            : nothing
        }
        ${
          items.length === 0 && searchSettled
            ? html`<div class="cmd-palette__no-results" role="status">
                <span class="cmd-palette__no-results-icon" aria-hidden="true"
                  >${icons.messageSquarePlus}</span
                >
                <h2>${t("palette.noResults")}</h2>
                <p>${t("palette.noResultsStart", { shortcut: startShortcut })}</p>
              </div>`
            : nothing
        }
        ${
          props.draft.error
            ? html`<div class="cmd-palette__creation-error" role="alert">${props.draft.error}</div>`
            : nothing
        }
        <div id="cmd-palette-keys" class="cmd-palette__footer">
          ${props.draft.renderRecovery()}
          ${
            items.length > 0 && !props.query.includes("\n")
              ? html`<span><kbd>↑↓</kbd> ${t("palette.footer.navigate")}</span>
                  <span><kbd>↵</kbd> ${t("palette.footer.select")}</span>`
              : nothing
          }
          <span
            ><kbd>${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newline)}</kbd>
            ${t("palette.footer.newline")}</span
          >
        </div>
      </div>
    </openclaw-modal-dialog>
    ${props.draft.renderAuxiliary()}
  `;
}
