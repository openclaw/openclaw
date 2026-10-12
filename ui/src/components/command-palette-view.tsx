import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { GatewayAgentRow } from "../api/types.ts";
import {
  pathForAgentPanel,
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  type RouteId,
} from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { registerCommandPaletteEnglish } from "../i18n/locales/en-command-palette.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import { MAX_HUMAN_MENTIONS } from "../lib/chat/human-mentions.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { LitContent } from "../lit/solid-bridge.ts";
import { paneDomId } from "../pages/chat/components/chat-composer-dom.ts";
import {
  HumanMentionMenuView,
  type HumanMentionMenu,
  type HumanMentionMenuHost,
} from "../pages/chat/components/chat-composer-mention-menu.tsx";
import { SelectedHumanMentions } from "../pages/chat/components/chat-composer-selected-mentions.tsx";
import "../styles/command-palette.css";
import type { PaletteSessionDraft } from "../pages/new-session/palette-session-draft.ts";
import {
  commandPaletteCategoryLabel,
  filterCommandPaletteItems,
  type CommandPaletteItem,
} from "./command-palette-catalog-search.ts";
import { COMMAND_PALETTE_DIALOG_STYLE } from "./command-palette-contract.ts";
import { COMMAND_PALETTE_INPUT_ID } from "./command-palette-input.ts";
import { CommandPaletteInput } from "./command-palette-input.tsx";
import { CommandPaletteResult } from "./command-palette-result.tsx";
import { SESSION_ACTION_PREFIX } from "./command-palette-session-search.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
} from "./panel-toggle-contract.ts";
import { Icon } from "./solid/icon.tsx";
import "./modal-dialog.ts";
import "./tooltip.ts";
import { Kbd, KeyboardShortcut, ShortcutText } from "./solid/kbd.tsx";

registerCommandPaletteEnglish();

export type PaletteFilter = "all" | "sessions" | "messages";

export type CommandPaletteProps = {
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

function resolvePaletteResults(snapshot: CommandPaletteProps) {
  const hideSearch =
    snapshot.promptMode || snapshot.mentionMenu.open || snapshot.draft.mentions.length > 0;
  const matches = hideSearch
    ? []
    : filterCommandPaletteItems({
        ...snapshot,
        query: snapshot.searchQuery,
        includeSlashCommands: Boolean(snapshot.onSlashCommand),
      });
  const grouped = groupItems(matches.filter((item) => matchesFilter(item, snapshot.filter)));
  const items = grouped.flatMap(([, entries]) => entries);
  // Preserve explicit selection through transient result changes, but only
  // highlight and execute current rows; an absent choice selects the first row.
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === snapshot.activeId),
  );
  return { hideSearch, matches, grouped, items, activeIndex };
}

function PaletteHint(props: { shortcut: SolidJSX.Element; label: string }) {
  return (
    <span class="cmd-palette__hint">
      {props.shortcut} <span>{props.label}</span>
    </span>
  );
}

function PaletteOption(props: {
  item: CommandPaletteItem;
  results: ReturnType<typeof resolvePaletteResults>;
  readProps: () => CommandPaletteProps;
}) {
  const current = () => props.readProps();
  const index = () => props.results.items.indexOf(props.item);
  const active = () => index() === props.results.activeIndex;
  const agentId = () =>
    props.item.session
      ? resolveUiSessionRowAgentId(props.item.session!, current().defaultAgentId)
      : props.item.agentId;
  const agent = () =>
    agentId()
      ? (current().agents.find((row) => row.id === agentId()) ?? { id: agentId()! })
      : undefined;
  return (
    <div
      id={getOptionId(index())}
      class={[
        "cmd-palette__item",
        {
          "cmd-palette__item--session": Boolean(props.item.session),
          "cmd-palette__item--active": active(),
        },
      ]}
      role="option"
      aria-selected={active() ? "true" : "false"}
      aria-disabled={current().draft.submitting || current().searchDebouncing ? "true" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        selectItem(props.item, current());
      }}
      onMouseEnter={() => current().onActiveIdChange(props.item.id)}
    >
      <CommandPaletteResult
        item={props.item}
        query={current().searchQuery}
        agent={agent()}
        identity={current().agentIdentity?.get(agentId())}
        pluginIconUrls={current().pluginIconUrls}
        onPluginIconError={current().onPluginIconError}
      />
    </div>
  );
}

function PaletteSearch(props: { readProps: () => CommandPaletteProps }) {
  const current = () => props.readProps();
  const results = createMemo(() => resolvePaletteResults(current()));
  const notices = () =>
    [
      current().sessionSearchFailed
        ? t("palette.searchFailed")
        : current().sessionSearchIndexing
          ? t("palette.searchIndexing")
          : current().sessionSearchPartial
            ? t("palette.searchPartial")
            : null,
      current().archivedTranscriptsExcluded > 0
        ? t("sessionsView.transcriptSearchArchivedExcluded", {
            count: String(current().archivedTranscriptsExcluded),
          })
        : null,
    ].filter((notice): notice is string => Boolean(notice));
  const searchSettled = () =>
    Boolean(current().searchQuery.trim()) &&
    !current().sessionSearchPending &&
    !current().catalogSearchPending &&
    !current().modelSearchError &&
    !current().sessionSearchFailed &&
    !current().sessionSearchPartial &&
    !current().sessionSearchIndexing &&
    current().archivedTranscriptsExcluded === 0;
  return (
    <>
      <Show when={current().searchQuery.trim() && current().onSelectSession}>
        <div class="cmd-palette__filters" role="group" aria-label={t("palette.filterLabel")}>
          <For each={["all", "sessions", "messages"] as const}>
            {(filter) => (
              <button
                type="button"
                class="cmd-palette__filter"
                aria-pressed={current().filter === filter ? "true" : "false"}
                onClick={() => current().onFilterChange(filter)}
              >
                {t(`palette.filters.${filter}`)}
                <span>
                  {results().matches.filter((item) => matchesFilter(item, filter)).length}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={current().sessionSearchPending || current().catalogSearchPending}>
        <div class="cmd-palette__empty" role="status">
          {t(
            current().sessionSearchPending
              ? "palette.searchingSessions"
              : "palette.searchingCommands",
          )}
        </div>
      </Show>
      <div
        id={paletteListboxId}
        class="cmd-palette__results"
        hidden={results().items.length === 0}
        role="listbox"
        aria-label={t("palette.placeholder")}
        aria-busy={
          current().searchDebouncing ||
          current().sessionSearchPending ||
          current().catalogSearchPending
            ? "true"
            : "false"
        }
      >
        <For each={results().grouped} keyed={(group) => group[0]}>
          {(group) => (
            <>
              <div class="cmd-palette__group-label">
                {commandPaletteCategoryLabel(group()[0])}
                <span class="cmd-palette__group-count">{group()[1].length}</span>
              </div>
              <For each={group()[1]} keyed={(item) => item.id}>
                {(item) => <PaletteOption item={item()} results={results()} readProps={current} />}
              </For>
            </>
          )}
        </For>
      </div>
      <For each={[current().modelSearchError, ...notices()].filter(Boolean)}>
        {(notice) => (
          <div class="cmd-palette__source-error" role="status">
            {notice}
          </div>
        )}
      </For>
      <Show when={results().items.length === 0 && searchSettled()}>
        <div class="cmd-palette__no-results" role="status">
          <span class="cmd-palette__no-results-icon" aria-hidden="true">
            <Icon name="messageSquarePlus" />
          </span>
          <h2>{t("palette.noResults")}</h2>
          <p>
            <ShortcutText
              text={t("palette.noResultsStart", { shortcut: "{shortcut}" })}
              shortcut={() => (
                <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.modifiedEnter} inline />
              )}
            />
          </p>
        </div>
      </Show>
      <div id="cmd-palette-keys" class="cmd-palette__footer">
        <Show when={results().items.length > 0 && !current().query.includes("\n")}>
          <PaletteHint shortcut={<Kbd keys={["↑", "↓"]} />} label={t("palette.footer.navigate")} />
          <PaletteHint shortcut={<Kbd keys="↵" />} label={t("palette.footer.select")} />
        </Show>
        <PaletteHint
          shortcut={<KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.newline} />}
          label={t("palette.footer.newline")}
        />
      </div>
    </>
  );
}

function PaletteActions(props: { readProps: () => CommandPaletteProps }) {
  const current = () => props.readProps();
  const reason = () =>
    current().draft.disabledReason ??
    (current().draft.hasPrompt ? undefined : t("palette.promptRequired"));
  return (
    <>
      <openclaw-tooltip prop:content={reason() ?? t("palette.startSessionBackground")}>
        <button
          type="button"
          class="cmd-palette__create"
          aria-label={t("palette.startSessionBackground")}
          aria-busy={current().draft.submitting ? "true" : "false"}
          disabled={current().composing || !current().draft.canSubmit}
          onClick={() => {
            if (!current().composing) {
              void current().draft.submit();
            }
          }}
        >
          {t(current().draft.submitting ? "palette.startingSession" : "palette.startSession")}
          <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.modifiedEnter} />
        </button>
      </openclaw-tooltip>
      <LitContent render={() => current().draft.renderControls()} />
    </>
  );
}

function OpenPalette(props: { readProps: () => CommandPaletteProps }) {
  const current = () => props.readProps();
  const hideSearch = () =>
    current().promptMode || current().mentionMenu.open || current().draft.mentions.length > 0;
  // The collapsing search remains mounted with its last presented projection.
  const search = createParkedProjection(current, () => !hideSearch());
  const results = createMemo(() => resolvePaletteResults(current()));
  const mentionListboxId = () => paneDomId(current().mentionHost.paneId, "mention-menu-listbox");
  const mentionAnnouncementId = () =>
    paneDomId(current().mentionHost.paneId, "mention-announcement");
  const recovery = createMemo(() => current().draft.renderRecovery());
  return (
    <>
      <openclaw-modal-dialog
        class="cmd-palette-overlay palette"
        label={t("palette.placeholder")}
        style={COMMAND_PALETTE_DIALOG_STYLE}
        onModal-cancel={(event: Event) => {
          if (current().composing || current().mentionMenu.open) {
            event.preventDefault();
            if (!current().composing) {
              current().mentionMenu.close();
              current().requestUpdate();
            }
            return;
          }
          if (current().draft.submitting) {
            event.preventDefault();
            return;
          }
          current().onToggle();
        }}
      >
        <div
          class={["cmd-palette", { "cmd-palette--prompt": hideSearch() }]}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => handleKeydown(event, current)}
        >
          <CommandPaletteInput
            value={current().query}
            placeholder={t("palette.placeholder")}
            onInputRef={current().onInputRef}
            onValueChange={current().onQueryChange}
            onBeforeInput={current().onBeforeInput}
            onSelectionChange={current().onSelectionChange}
            onCompositionStart={current().onCompositionStart}
            onCompositionEnd={current().onCompositionEnd}
            onPaste={(event) => current().draft.pasteImages(event)}
            disabled={current().draft.submitting}
            readOnly={current().draft.messageLocked}
            controls={
              current().mentionMenu.open
                ? mentionListboxId()
                : hideSearch()
                  ? undefined
                  : paletteListboxId
            }
            activeDescendant={
              current().mentionMenu.open
                ? current().draft.mentions.length < MAX_HUMAN_MENTIONS
                  ? (current().mentionMenu.activeId(current().mentionHost.paneId) ?? undefined)
                  : undefined
                : !current().searchDebouncing && results().items[results().activeIndex]
                  ? getOptionId(results().activeIndex)
                  : undefined
            }
            describedBy={
              current().mentionMenu.open
                ? mentionAnnouncementId()
                : hideSearch()
                  ? undefined
                  : "cmd-palette-keys"
            }
            actions={<PaletteActions readProps={current} />}
          />
          <Show when={current().draft.mentions.length > 0}>
            <div class="cmd-palette__mentions" inert={current().draft.messageLocked}>
              <SelectedHumanMentions
                text={current().query}
                mentions={current().draft.mentions}
                onRemove={() => {
                  current().draft.setMessage(current().query, []);
                  current().requestUpdate();
                  current().mentionHost.getTextarea()?.focus({ preventScroll: true });
                }}
                avatarUrls={current().mentionMenu.selectedAvatarUrls}
              />
            </div>
          </Show>
          <LitContent render={() => current().draft.renderAttachments()} />
          <HumanMentionMenuView
            args={[current().mentionMenu, current().mentionHost, current().requestUpdate]}
          />
          <span
            id={mentionAnnouncementId()}
            class="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {current().mentionMenu.activeLabel()}
          </span>
          <div
            class="cmd-palette__search"
            inert={hideSearch()}
            aria-hidden={hideSearch() ? "true" : undefined}
          >
            <div class="cmd-palette__search-content">
              <PaletteSearch readProps={search} />
            </div>
          </div>
          <Show when={current().draft.error}>
            <div class="cmd-palette__creation-error" role="alert">
              {current().draft.error}
            </div>
          </Show>
          <Show when={recovery()}>
            <div class="cmd-palette__footer">
              <LitContent render={() => recovery()} />
            </div>
          </Show>
        </div>
      </openclaw-modal-dialog>
      <LitContent render={() => current().draft.renderAuxiliary()} />
    </>
  );
}

export function CommandPaletteView(props: { readProps: () => CommandPaletteProps }) {
  return (
    <Show when={props.readProps().open}>
      <OpenPalette readProps={props.readProps} />
    </Show>
  );
}
