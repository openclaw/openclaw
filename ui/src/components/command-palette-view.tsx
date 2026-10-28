import { createDeferred } from "@solidjs/signals";
import type { JSX as SolidJSX } from "@solidjs/web";
import {
  createMemo,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Show,
  type Accessor,
} from "solid-js";
import {
  pathForAgentPanel,
  pathForPluginCatalogEntry,
  pathForPluginSettings,
  type RouteId,
} from "../app-route-paths.ts";
import { registerCommandPaletteEnglish } from "../i18n/locales/en-command-palette.ts";
import { isMobileBrowserPlatform, keepMobileReturnNative } from "../lib/browser-platform.ts";
import { MAX_HUMAN_MENTIONS } from "../lib/chat/human-mentions.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { t } from "../lib/reactive/i18n.ts";
import { keyboardHintsVisible } from "../lib/reactive/keyboard-hints.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { resolveUiSessionRowAgentId } from "../lib/sessions/session-key.ts";
import { paneDomId } from "../pages/chat/components/chat-composer-dom.ts";
import { HumanMentionMenuView } from "../pages/chat/components/chat-composer-mention-menu.tsx";
import { SelectedHumanMentions } from "../pages/chat/components/chat-composer-selected-mentions.tsx";
import {
  PaletteSessionAttachments,
  PaletteSessionControls,
  PaletteSessionAuxiliary,
  PaletteSessionRecovery,
} from "../pages/new-session/palette-session-draft-view.tsx";
import { PaletteSessionDraft } from "../pages/new-session/palette-session-draft.ts";
import { createSubmissionAction } from "../pages/new-session/submission-action.ts";
import "../styles/command-palette.css";
import {
  commandPaletteCategoryLabel,
  filterCommandPaletteItems,
  getStaticCommandPaletteCatalogItems,
  type CommandPaletteItem,
} from "./command-palette-catalog-search.ts";
import { COMMAND_PALETTE_DIALOG_STYLE } from "./command-palette-contract.ts";
import {
  COMMAND_PALETTE_INPUT_ID,
  CommandPaletteInput,
  CommandPaletteModes,
} from "./command-palette-input.tsx";
import { createCommandPaletteMatches } from "./command-palette-matches.ts";
import { CommandPaletteResult } from "./command-palette-result.tsx";
import { SESSION_ACTION_PREFIX } from "./command-palette-session-search.ts";
import type { CommandPaletteState, PaletteFilter } from "./command-palette-state.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
} from "./panel-toggle-contract.ts";
import { Icon } from "./solid/icon.tsx";
import "./modal-dialog.tsx";
import "./tooltip.ts";
import { Kbd, KeyboardShortcut, ShortcutText } from "./solid/kbd.tsx";

registerCommandPaletteEnglish();

type CommandPaletteProps = ReturnType<CommandPaletteState["readProps"]>;

function groupItems(items: CommandPaletteItem[]): Array<[string, CommandPaletteItem[]]> {
  const map = new Map<string, CommandPaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

const paletteListboxId = "cmd-palette-listbox";

function selectItem(item: CommandPaletteItem, props: CommandPaletteProps) {
  if (props.draft.submitting || props.searchDebouncing) {
    return;
  }
  if (item.action === "nav:new-session") {
    props.onModeChange("compose");
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

function handleKeydown(
  event: KeyboardEvent,
  readProps: () => CommandPaletteProps,
  activeElement: () => HTMLElement | undefined,
) {
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
  if (
    !(event.target instanceof HTMLTextAreaElement) ||
    event.target.id !== COMMAND_PALETTE_INPUT_ID
  ) {
    return;
  }
  if (keepMobileReturnNative(event)) {
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
    props.mentionMenu.handleKeydown(event, props.mentionHost)
  ) {
    event.stopPropagation();
    return;
  }
  if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      props.onModeChange(props.mode === "search" ? "compose" : "search");
    }
    return;
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.modifiedEnter, event)) {
    event.preventDefault();
    event.stopPropagation();
    if (props.mode === "compose") {
      void props.draft.submit();
    }
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
  if (event.key !== "Enter" && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
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
  if (items.length === 0 || props.query.includes("\n")) {
    return;
  }
  event.preventDefault();
  const direction = event.key === "ArrowDown" ? 1 : -1;
  props.onActiveIdChange(items[(activeIndex + direction + items.length) % items.length]!.id);
  requestAnimationFrame(() => activeElement()?.scrollIntoView({ block: "nearest" }));
}

function getOptionId(index: number): string {
  return `cmd-palette-option-${index}`;
}

function matchesFilter(item: CommandPaletteItem, filter: PaletteFilter) {
  return filter === "all" || item.category === (filter === "sessions" ? "chats" : "messages");
}

function resolvePaletteResults(snapshot: CommandPaletteProps, prepared?: CommandPaletteItem[]) {
  const hideSearch = snapshot.mode === "compose";
  const matches =
    prepared ??
    (hideSearch
      ? []
      : filterCommandPaletteItems({
          ...snapshot,
          catalogItems: [
            ...getStaticCommandPaletteCatalogItems(
              snapshot.canAdmin,
              snapshot.nativeDeviceSettings,
            ),
            ...snapshot.catalogItems,
            ...snapshot.modelItems,
          ],
          query: snapshot.searchQuery,
          includeSlashCommands: Boolean(snapshot.onSlashCommand),
        }));
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
    <Show when={keyboardHintsVisible()}>
      <span class="cmd-palette__hint">
        {props.shortcut} <span>{props.label}</span>
      </span>
    </Show>
  );
}

function PaletteNewlineHint() {
  return (
    <PaletteHint
      shortcut={
        <KeyboardShortcut
          combo={
            isMobileBrowserPlatform()
              ? KEYBOARD_SHORTCUT_COMBOS.sendMessage
              : KEYBOARD_SHORTCUT_COMBOS.newline
          }
        />
      }
      label={t("palette.footer.newline")}
    />
  );
}

function PaletteSearch(props: {
  readProps: () => CommandPaletteProps;
  readCurrentProps: () => CommandPaletteProps;
  results: ReturnType<typeof resolvePaletteResults>;
  sessionRead: Accessor<void | undefined>;
  catalogRead: Accessor<void | undefined>;
  modelRead: Accessor<unknown>;
  optionElements: Map<string, HTMLDivElement>;
}) {
  const current = () => props.readProps();
  const sessionSearchPending = () => isPending(props.sessionRead);
  // A cold receipt can suspend a pending probe; owner facts keep filtering live.
  const catalogSearchPending = () =>
    Boolean(current().searchQuery.trim()) &&
    current().mode !== "compose" &&
    current().catalogSearchPending;
  const readCatalog = () => {
    latest(props.catalogRead);
    latest(props.modelRead);
    return null;
  };
  const results = () => props.results;
  const notices = () =>
    [
      current().remoteSearchOffline ? t("palette.searchOffline") : null,
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
    !sessionSearchPending() &&
    !catalogSearchPending() &&
    !current().remoteSearchOffline &&
    !current().modelSearchError &&
    !current().sessionSearchFailed &&
    !current().sessionSearchPartial &&
    !current().sessionSearchIndexing &&
    current().archivedTranscriptsExcluded === 0;
  return (
    <>
      {(latest(props.sessionRead), null)}
      {/* A cold catalog read must not hide already available commands. */}
      <Loading>{readCatalog()}</Loading>
      <Show when={current().searchQuery.trim() && current().onSelectSession}>
        <div class="cmd-palette__filters" role="group" aria-label={t("palette.filterLabel")}>
          <For each={["all", "sessions", "messages"] as const}>
            {(filter) => (
              <button
                type="button"
                class="cmd-palette__filter"
                aria-pressed={current().filter === filter ? "true" : "false"}
                onClick={() => props.readCurrentProps().onFilterChange(filter)}
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
      <Show when={sessionSearchPending() || catalogSearchPending()}>
        <div class="cmd-palette__empty" role="status">
          {t(sessionSearchPending() ? "palette.searchingSessions" : "palette.searchingCommands")}
        </div>
      </Show>
      <div
        id={paletteListboxId}
        class="cmd-palette__results"
        hidden={results().items.length === 0}
        role="listbox"
        aria-label={t("palette.placeholder")}
        aria-busy={
          current().searchDebouncing || sessionSearchPending() || catalogSearchPending()
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
                {(item) => {
                  const optionRef = (key: string) =>
                    elementRef<HTMLDivElement>((element) => {
                      props.optionElements.set(key, element);
                      return () => props.optionElements.delete(key);
                    });
                  const index = () => results().items.indexOf(item());
                  const active = () => index() === results().activeIndex;
                  const agentId = () =>
                    item().session
                      ? resolveUiSessionRowAgentId(item().session!, current().defaultAgentId)
                      : item().agentId;
                  const agent = () =>
                    agentId()
                      ? (current().agents.find((row) => row.id === agentId()) ?? { id: agentId()! })
                      : undefined;
                  return (
                    <div
                      ref={[optionRef(`${item().category}:${item().id}`)]}
                      id={getOptionId(index())}
                      class={[
                        "cmd-palette__item",
                        {
                          "cmd-palette__item--session": Boolean(item().session),
                          "cmd-palette__item--active": active(),
                        },
                      ]}
                      role="option"
                      aria-selected={active() ? "true" : "false"}
                      aria-disabled={
                        current().draft.submitting || current().searchDebouncing
                          ? "true"
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        selectItem(item(), props.readCurrentProps());
                      }}
                      onMouseEnter={() => props.readCurrentProps().onActiveIdChange(item().id)}
                    >
                      <CommandPaletteResult
                        item={item()}
                        query={current().searchQuery}
                        agent={agent()}
                        identity={current().agentIdentity?.get(agentId())}
                        pluginIconUrls={current().pluginIconUrls}
                        onPluginIconError={current().onPluginIconError}
                        registerPluginIcon={current().registerPluginIcon}
                      />
                    </div>
                  );
                }}
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
          <Show when={!isMobileBrowserPlatform()}>
            <p>
              <ShortcutText
                text={t("palette.noResultsStart", { shortcut: "{shortcut}" })}
                shortcut={() => <Kbd keys="Tab" />}
              />
            </p>
          </Show>
        </div>
      </Show>
      <div id="cmd-palette-keys" class="cmd-palette__footer">
        <Show when={results().items.length > 0 && !current().query.includes("\n")}>
          <PaletteHint shortcut={<Kbd keys={["↑", "↓"]} />} label={t("palette.footer.navigate")} />
          <Show when={!isMobileBrowserPlatform()}>
            <PaletteHint shortcut={<Kbd keys="↵" />} label={t("palette.footer.select")} />
          </Show>
        </Show>
        <PaletteNewlineHint />
      </div>
    </>
  );
}

export function CommandPaletteView(props: { readProps: () => CommandPaletteProps }) {
  let initialInput!: HTMLTextAreaElement;
  // Share one presentation snapshot; event handlers retain synchronous owner reads.
  const current = createMemo(() => props.readProps());
  const readCurrent = () => props.readProps();
  const drop = PaletteSessionDraft.createDropHandlers(() => readCurrent().draft);
  const error = createMemo(() => current().draft.error);
  const saving = createSubmissionAction(
    () => readCurrent().draft,
    current,
    error,
    (failure) => readCurrent().draft.setSubmissionError(failure),
  );
  const hideSearch = () => current().mode === "compose";
  // The collapsing search remains mounted with its last presented projection.
  const search = createParkedProjection(current, () => !hideSearch());
  const matches = createCommandPaletteMatches(search);
  const results = createMemo(() => resolvePaletteResults(search(), matches()));
  const sessionRequest = createMemo(() => search().sessionSearchRead);
  const sessionRead = createMemo(() => sessionRequest()?.promise);
  const catalogRequest = createMemo(() => search().catalogSearchRead);
  // Readiness may lag; it must never hold synchronous catalog invalidation.
  const catalogRead = createDeferred(() => catalogRequest()?.promise);
  const modelRequest = createMemo(() => search().modelSearchRead);
  const modelRead = createDeferred(() => modelRequest()?.promise);
  const optionElements = new Map<string, HTMLDivElement>();
  const activeElement = () => {
    if (hideSearch()) {
      return undefined;
    }
    const item = results().items[results().activeIndex];
    return item && optionElements.get(`${item.category}:${item.id}`);
  };
  const mentionListboxId = () => paneDomId(current().mentionHost.paneId, "mention-menu-listbox");
  const mentionAnnouncementId = () =>
    paneDomId(current().mentionHost.paneId, "mention-announcement");
  const recovery = createMemo(() => current().draft.recoveryAction);
  const reason = () =>
    current().draft.disabledReason ??
    (current().draft.hasPrompt ? undefined : t("palette.promptRequired"));
  return (
    <>
      <openclaw-modal-dialog
        prop:initialFocus={() => initialInput}
        class="cmd-palette-overlay palette"
        label={t("palette.placeholder")}
        style={COMMAND_PALETTE_DIALOG_STYLE}
        onModal-cancel={(event: Event) => {
          const snapshot = readCurrent();
          if (snapshot.composing || snapshot.mentionMenu.open) {
            event.preventDefault();
            if (!snapshot.composing) {
              snapshot.mentionMenu.close();
            }
            return;
          }
          if (snapshot.draft.submitting) {
            event.preventDefault();
            return;
          }
          snapshot.onToggle();
        }}
      >
        <CommandPaletteModes
          mode={current().mode}
          onChange={current().onModeChange}
          disabled={current().composing || current().draft.submitting}
        />
        <div
          id="cmd-palette-panel"
          role="tabpanel"
          aria-labelledby={`cmd-palette-tab-${current().mode}`}
          class={["cmd-palette", { "cmd-palette--prompt": hideSearch() }]}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => handleKeydown(event, readCurrent, activeElement)}
          onDragEnter={drop.onDragenter}
          onDragLeave={drop.onDragleave}
          onDragOver={drop.onDragover}
          onDrop={drop.onDrop}
        >
          <CommandPaletteInput
            onAutofocusRef={(element) => {
              initialInput = element;
            }}
            value={current().query}
            placeholder={t(
              current().mode === "compose"
                ? current().draft.attachmentMode
                  ? "palette.attachmentPrompt"
                  : "palette.composePlaceholder"
                : "palette.placeholder",
            )}
            onInputRef={current().onInputRef}
            onValueChange={current().onQueryChange}
            onBeforeInput={current().onBeforeInput}
            onSelectionChange={current().onSelectionChange}
            onCompositionStart={current().onCompositionStart}
            onCompositionEnd={current().onCompositionEnd}
            onPaste={(event) => readCurrent().draft.pasteImages(event)}
            busy={current().draft.submitting}
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
                : !hideSearch() &&
                    !current().searchDebouncing &&
                    results().items[results().activeIndex]
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
            actions={
              <Show when={current().mode === "compose"}>
                <openclaw-tooltip prop:content={reason() ?? t("palette.startSessionBackground")}>
                  <button
                    type="button"
                    class="cmd-palette__create"
                    aria-label={t("palette.startSessionBackground")}
                    aria-busy={saving() || current().draft.submitting ? "true" : "false"}
                    disabled={current().composing || !current().draft.canSubmit}
                    onClick={() => {
                      const snapshot = readCurrent();
                      if (!snapshot.composing) {
                        void snapshot.draft.submit();
                      }
                    }}
                  >
                    {t(
                      current().draft.submitting
                        ? "palette.startingSession"
                        : "palette.startSession",
                    )}
                    <Show when={!isMobileBrowserPlatform()}>
                      <KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.modifiedEnter} />
                    </Show>
                  </button>
                </openclaw-tooltip>
                <PaletteSessionControls draft={current().draft} revision={current()} />
              </Show>
            }
          />
          <Show when={current().mode === "compose" && current().draft.mentions.length > 0}>
            <div class="cmd-palette__mentions" inert={current().draft.messageLocked}>
              <SelectedHumanMentions
                text={current().query}
                mentions={current().draft.mentions}
                onRemove={() => {
                  const snapshot = readCurrent();
                  snapshot.draft.setMessage(snapshot.query, []);
                  snapshot.onMentionChange();
                  snapshot.mentionHost.getTextarea()?.focus({ preventScroll: true });
                }}
                avatarUrls={current().mentionMenu.selectedAvatarUrls}
              />
            </div>
          </Show>
          <Show when={current().mode === "compose"}>
            <PaletteSessionAttachments draft={current().draft} revision={current()} />
          </Show>
          <HumanMentionMenuView args={[current().mentionMenu, current().mentionHost]} />
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
              <Errored
                fallback={() => (
                  <div class="cmd-palette__source-error" role="status">
                    {t("palette.searchFailed")}
                  </div>
                )}
              >
                <Loading
                  fallback={
                    <div class="cmd-palette__empty" role="status">
                      {t("palette.searchingSessions")}
                    </div>
                  }
                >
                  <PaletteSearch
                    readProps={search}
                    readCurrentProps={readCurrent}
                    results={results()}
                    sessionRead={sessionRead}
                    catalogRead={catalogRead}
                    modelRead={modelRead}
                    optionElements={optionElements}
                  />
                </Loading>
              </Errored>
            </div>
          </div>
          <Show when={current().mode === "compose" && current().draft.attachmentMode}>
            <div class="cmd-palette__footer">
              <Show when={!isMobileBrowserPlatform()}>
                <PaletteHint
                  shortcut={<KeyboardShortcut combo={KEYBOARD_SHORTCUT_COMBOS.modifiedEnter} />}
                  label={t("palette.startSession")}
                />
              </Show>
              <PaletteNewlineHint />
            </div>
          </Show>
          <Show when={current().mode === "compose" && error()}>
            <div class="cmd-palette__creation-error" role="alert">
              {error()}
            </div>
          </Show>
          <Show when={current().mode === "compose" && recovery()}>
            <div class="cmd-palette__footer">
              <PaletteSessionRecovery onOpen={() => recovery()?.()} />
            </div>
          </Show>
        </div>
      </openclaw-modal-dialog>
      <PaletteSessionAuxiliary draft={current().draft} revision={current()} />
    </>
  );
}
