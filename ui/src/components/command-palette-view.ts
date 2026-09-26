import { html, noChange, nothing } from "lit";
import type { GatewayAgentRow } from "../api/types.ts";
import {
  pathForAgentPanel,
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  type RouteId,
} from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../i18n/locales/en-command-palette.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import { MAX_HUMAN_MENTIONS } from "../lib/chat/human-mentions.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { paneDomId } from "../pages/chat/components/chat-composer-dom.ts";
import type {
  HumanMentionMenu,
  HumanMentionMenuHost,
} from "../pages/chat/components/chat-composer-mention-menu.ts";
import { renderSelectedHumanMentions } from "../pages/chat/components/chat-composer-selected-mentions.ts";
import type { PaletteSessionDraft } from "../pages/new-session/palette-session-draft.ts";
import "../styles/command-palette.css";
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

export type PaletteFilter = "all" | "sessions" | "messages";

type CommandPaletteProps = {
  basePath: string;
  open: boolean;
  query: string;
  searchQuery: string;
  searchDebouncing: boolean;
  onFlushSearch: () => void;
  promptMode: boolean;
  activeId: string | null;
  filter: PaletteFilter;
  onFilterChange: (filter: PaletteFilter) => void;
  agents: readonly GatewayAgentRow[];
  agentIdentity?: AgentIdentityCapability;
  defaultAgentId: string;
  sessionItems: readonly CommandPaletteItem[];
  catalogItems: readonly CommandPaletteItem[];
  primaryModelSearch: boolean;
  modelSearchError: string | null;
  sessionSearchPending: boolean;
  catalogSearchPending: boolean;
  sessionSearchFailed: boolean;
  sessionSearchPartial: boolean;
  sessionSearchIndexing: boolean;
  archivedTranscriptsExcluded: number;
  onToggle: () => void;
  onQueryChange: (query: string, event: InputEvent) => void;
  onBeforeInput: (event: InputEvent) => void;
  onSelectionChange: (event: Event) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  composing: boolean;
  mentionMenu: HumanMentionMenu;
  mentionHost: HumanMentionMenuHost;
  requestUpdate: () => void;
  onActiveIdChange: (id: string) => void;
  onNavigate?: ApplicationContext["navigate"];
  onSelectSession?: (sessionKey: string) => void;
  onSlashCommand?: (command: string) => void;
  pluginIconUrls: Readonly<Record<string, string>>;
  onPluginIconError: (pluginId: string) => void;
  desktopAvailable: boolean;
  custodianAvailable: boolean;
  onInputRef: (element: Element | undefined) => void;
  draft: PaletteSessionDraft;
};

function groupItems(items: CommandPaletteItem[]): Array<[string, CommandPaletteItem[]]> {
  const map = new Map<string, CommandPaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

const paletteInputId = COMMAND_PALETTE_INPUT_ID;
const paletteListboxId = "cmd-palette-listbox";

function selectItem(item: CommandPaletteItem, props: CommandPaletteProps) {
  if (props.draft.submitting || props.searchDebouncing) {
    return;
  }
  if (item.action.startsWith("nav:")) {
    // SAFETY: the palette catalog builds every nav: action from a RouteId value.
    const routeId = item.action.slice(4) as RouteId;
    if (item.agentId) {
      props.onNavigate?.(routeId, {
        pathname: pathForAgentPanel(item.agentId, null, props.basePath),
      });
    } else if (item.catalogId) {
      props.onNavigate?.(routeId, {
        pathname: pathForPluginCatalogEntry(item.catalogId, props.basePath),
      });
    } else if (item.pluginId && routeId === "plugin-settings") {
      props.onNavigate?.(routeId, {
        pathname: pathForPluginSettings(item.pluginId, props.basePath),
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

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(event: KeyboardEvent, readProps: () => CommandPaletteProps) {
  let props = readProps();
  if (event.defaultPrevented) {
    return;
  }
  if (props.composing || event.isComposing || event.keyCode === 229) {
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
  if (
    !props.draft.messageLocked &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    props.mentionMenu.handleKeydown(event, props.mentionHost, props.requestUpdate)
  ) {
    event.stopPropagation();
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
    props.onToggle();
    return;
  }
  if (props.draft.submitting) {
    return;
  }
  if (event.key === "Enter" && props.searchDebouncing) {
    props.onFlushSearch();
    // Read the applied query and retired rows, not the previous render snapshot.
    props = readProps();
  }
  const { items: matches, activeIndex } = resolvePaletteResults(props);
  const items = props.searchDebouncing ? [] : matches;
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

function matchesFilter(item: CommandPaletteItem, filter: PaletteFilter) {
  return filter === "all" || item.category === (filter === "sessions" ? "chats" : "messages");
}

function resolvePaletteResults(props: CommandPaletteProps) {
  const hideSearch = props.promptMode || props.mentionMenu.open || props.draft.mentions.length > 0;
  const matches = hideSearch
    ? []
    : filterCommandPaletteItems({
        ...props,
        query: props.searchQuery,
        includeSlashCommands: Boolean(props.onSlashCommand),
      });
  const grouped = groupItems(matches.filter((item) => matchesFilter(item, props.filter)));
  const items = grouped.flatMap(([, entries]) => entries);
  // Preserve explicit selection through transient result changes, but only
  // highlight and execute current rows; an absent choice selects the first row.
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === props.activeId),
  );
  return { hideSearch, matches, grouped, items, activeIndex };
}

export function renderCommandPalette(readProps: () => CommandPaletteProps) {
  const props = readProps();
  if (!props.open) {
    return nothing;
  }
  const mentionsOpen = props.mentionMenu.open;
  const mentionListboxId = paneDomId(props.mentionHost.paneId, "mention-menu-listbox");
  const mentionAnnouncementId = paneDomId(props.mentionHost.paneId, "mention-announcement");
  const { hideSearch, matches, grouped, items, activeIndex } = resolvePaletteResults(props);
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
  const activeOptionId =
    !props.searchDebouncing && items[activeIndex] ? getOptionId(activeIndex) : undefined;
  const paletteLabel = t("palette.placeholder");
  const startLabel = t(props.draft.submitting ? "palette.startingSession" : "palette.startSession");
  const startDisabled = props.composing || !props.draft.canSubmit;
  const startReason =
    props.draft.disabledReason ?? (props.draft.hasPrompt ? undefined : t("palette.promptRequired"));
  const startShortcut = formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter);
  const searchSettled =
    Boolean(props.searchQuery.trim()) &&
    !props.sessionSearchPending &&
    !props.catalogSearchPending &&
    !props.modelSearchError &&
    !props.sessionSearchFailed &&
    !props.sessionSearchPartial &&
    !props.sessionSearchIndexing &&
    props.archivedTranscriptsExcluded === 0;

  // Keep the outgoing search DOM stable while it collapses; the wrapper retires
  // focus/accessibility immediately, and keyboard selection uses the empty items.
  return html`
    <openclaw-modal-dialog
      class="cmd-palette-overlay palette"
      label=${paletteLabel}
      style=${COMMAND_PALETTE_DIALOG_STYLE}
      @modal-cancel=${(event: Event) => {
        if (props.composing || props.mentionMenu.open) {
          event.preventDefault();
          if (!props.composing) {
            props.mentionMenu.close();
            props.requestUpdate();
          }
          return;
        }
        if (props.draft.submitting) {
          event.preventDefault();
          return;
        }
        props.onToggle();
      }}
    >
      <div
        class="cmd-palette ${hideSearch ? "cmd-palette--prompt" : ""}"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, readProps)}
      >
        ${renderCommandPaletteInput({
          value: props.query,
          placeholder: paletteLabel,
          onInputRef: props.onInputRef,
          onValueChange: props.onQueryChange,
          onBeforeInput: props.onBeforeInput,
          onSelectionChange: props.onSelectionChange,
          onCompositionStart: props.onCompositionStart,
          onCompositionEnd: props.onCompositionEnd,
          onPaste: props.draft.pasteImages,
          disabled: props.draft.submitting,
          readOnly: props.draft.messageLocked,
          controls: mentionsOpen ? mentionListboxId : hideSearch ? undefined : paletteListboxId,
          activeDescendant: mentionsOpen
            ? ((props.draft.mentions.length < MAX_HUMAN_MENTIONS
                ? props.mentionMenu.activeId(props.mentionHost.paneId)
                : null) ?? undefined)
            : activeOptionId,
          describedBy: mentionsOpen
            ? mentionAnnouncementId
            : hideSearch
              ? undefined
              : "cmd-palette-keys",
          actions: html`
            <openclaw-tooltip content=${startReason ?? t("palette.startSessionBackground")}>
              <button
                type="button"
                class="cmd-palette__create"
                aria-label=${t("palette.startSessionBackground")}
                aria-busy=${String(props.draft.submitting)}
                ?disabled=${startDisabled}
                @click=${() => {
                  if (!props.composing) {
                    void props.draft.submit();
                  }
                }}
              >
                ${startLabel}<kbd>${startShortcut}</kbd>
              </button>
            </openclaw-tooltip>
            ${props.draft.renderControls()}
          `,
        })}
        ${
          props.draft.mentions.length
            ? html`<div class="cmd-palette__mentions" ?inert=${props.draft.messageLocked}>
                ${renderSelectedHumanMentions(
                  props.query,
                  props.draft.mentions,
                  () => {
                    props.draft.setMessage(props.query, []);
                    // The unchanged text needs search resumed after recipient metadata is removed.
                    props.requestUpdate();
                    props.mentionHost.getTextarea()?.focus({ preventScroll: true });
                  },
                  props.mentionMenu.selectedAvatarUrls,
                )}
              </div>`
            : nothing
        }
        ${props.draft.renderAttachments()}
        ${props.mentionMenu.render(props.mentionHost, props.requestUpdate)}
        <span
          id=${mentionAnnouncementId}
          class="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          >${props.mentionMenu.activeLabel()}</span
        >
        <div
          class="cmd-palette__search"
          ?inert=${hideSearch}
          aria-hidden=${hideSearch ? "true" : nothing}
        >
          <div class="cmd-palette__search-content">
            ${
              hideSearch
                ? noChange
                : html`
                    ${
                      props.searchQuery.trim() && props.onSelectSession
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
                      aria-label=${paletteLabel}
                      aria-busy=${props.searchDebouncing || props.sessionSearchPending || props.catalogSearchPending ? "true" : "false"}
                    >
                      ${grouped.map(
                        ([category, groupedItems]) => html`
                          <div class="cmd-palette__group-label">
                            ${commandPaletteCategoryLabel(category)}<span
                              class="cmd-palette__group-count"
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
                                aria-disabled=${props.draft.submitting || props.searchDebouncing ? "true" : nothing}
                                @click=${(e: Event) => {
                                  e.stopPropagation();
                                  selectItem(item, props);
                                }}
                                @mouseenter=${() => props.onActiveIdChange(item.id)}
                              >
                                ${renderCommandPaletteResult(item, props.searchQuery, agent, props.agentIdentity?.get(agentId), props.pluginIconUrls, props.onPluginIconError)}
                              </div>
                            `;
                          })}
                        `,
                      )}
                    </div>
                    ${props.modelSearchError ? html`<div class="cmd-palette__source-error" role="status">${props.modelSearchError}</div>` : nothing}
                    ${notices.map((notice) => html`<div class="cmd-palette__source-error" role="status">${notice}</div>`)}
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
                    <div id="cmd-palette-keys" class="cmd-palette__footer">
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
                  `
            }
          </div>
        </div>
        ${
          props.draft.error
            ? html`<div class="cmd-palette__creation-error" role="alert">${props.draft.error}</div>`
            : nothing
        }
        ${props.draft.renderRecovery() !== nothing ? html`<div class="cmd-palette__footer">${props.draft.renderRecovery()}</div>` : nothing}
      </div>
    </openclaw-modal-dialog>
    ${props.draft.renderAuxiliary()}
  `;
}
