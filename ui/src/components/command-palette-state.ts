// The palette owns search/navigation; its draft reuses the canonical session owners.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../app/operator-access.ts";
import { updateHumanMentions, type HumanMentionInput } from "../lib/chat/human-mentions.ts";
import { isCronInventoryInvalidation } from "../lib/cron/inventory-connection.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { GatewayPageBinding } from "../lib/gateway-page-binding.ts";
import { modelCatalogEventInvalidation } from "../lib/model-catalog-cache.ts";
import { ModelCatalogReader } from "../lib/model-catalog-reader.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { resolveUiSelectedGlobalAgentId } from "../lib/sessions/session-key.ts";
import { searchVisibleSessionTranscripts } from "../lib/sessions/transcript-search.ts";
import {
  createHumanMentionMenu,
  type HumanMentionMenuHost,
} from "../pages/chat/components/chat-composer-mention-menu-state.ts";
import { PaletteSessionDraft } from "../pages/new-session/palette-session-draft.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../pages/plugins/plugin-icon-owner.ts";
import {
  getCommandPaletteModelItems,
  loadCommandPaletteCatalogItems,
  type CommandPaletteItem,
} from "./command-palette-catalog-search.ts";
import {
  isCommandPaletteShortcut,
  type CommandPaletteOpenInput,
  type CommandPaletteInputHandoff,
} from "./command-palette-contract.ts";
import {
  buildCommandPaletteSessionItems,
  SESSION_SEARCH_LIMIT,
  SESSION_SEARCH_SCOPE,
} from "./command-palette-session-search.ts";
import type { OpenClawModalDialog } from "./modal-dialog.tsx";

const SEARCH_DEBOUNCE_MS = 200;
const SESSION_SEARCH_MIN_CHARS = 2;
const PROMPT_ENTER_CHARS = 60;
const PROMPT_EXIT_CHARS = 50;
const CATALOG_CACHE_TTL_MS = 30_000;

export type PaletteFilter = "all" | "sessions" | "messages";

export type CommandPaletteProperties = {
  onNavigate?: ApplicationContext["navigate"];
  onSelectSession?: (sessionKey: string) => void;
  onSlashCommand?: (command: string) => void;
  desktopAvailable: boolean;
  custodianAvailable: boolean;
};
/** Search and draft handoffs keep same-turn reads while Solid owns the presentation. */
export class CommandPaletteState {
  private publicationPending = false;
  private connected = false;
  readonly changed = () => {
    if (!this.connected || this.publicationPending) {
      return;
    }
    this.publicationPending = true;
    queueMicrotask(() => {
      if (this.connected) {
        this.draft.synchronize();
        this.draft.settled();
        if (this.open) {
          this.mentionMenu.syncDirectory(this.draft.mentionDirectory);
        }
      }
      this.publicationPending = false;
    });
    this.publish();
  };
  open = false;
  private pluginIconUrls: Record<string, string> = {};
  private readonly pluginIconTiles = new Set<() => string>();
  private readonly pluginIcons = new PluginIconOwner({
    getFetchContext: () => pluginIconFetchContext(this.context!),
    isConnected: () => this.element.isConnected && this.open && this.gateway.connected,
    onUrlsChange: (urls) => {
      this.pluginIconUrls = urls;
      this.changed();
    },
  });
  private initialInput: CommandPaletteOpenInput | CommandPaletteInputHandoff | undefined;
  private inputElement: HTMLTextAreaElement | undefined;
  private stopInputFocus: (() => void) | undefined;
  private readonly mentionMenu = createHumanMentionMenu((nextOpen) =>
    this.notifyMentionChange(nextOpen),
  );
  private hasOpened = false;
  private mentionInput: HumanMentionInput | undefined;
  private composing = false;
  private readonly mentionHost: HumanMentionMenuHost = {
    paneId: "command-palette",
    getDraft: () => this.draft.message,
    getMentions: () => this.draft.mentions,
    getTextarea: () => this.inputElement ?? null,
    commitDraft: (value, mentions) => this.draft.setMessage(value, mentions),
  };
  // Menu transitions arrive before Solid publishes the new store value.
  private readonly notifyMentionChange = (nextOpen = this.mentionMenu.open) => {
    if (nextOpen || this.draft.mentions.length > 0) {
      this.clearSessionSearch();
      this.clearCatalogSearch();
    } else {
      this.scheduleSessionSearch(this.draft.message, false, nextOpen);
    }
    this.changed();
  };
  private presentationScope: ReturnType<typeof gatewayPresentationScope> | undefined;
  private filter: PaletteFilter = "all";
  readonly draft: PaletteSessionDraft;

  private searchQuery = "";
  private textPromptMode = false;
  private get promptMode(): boolean {
    return this.textPromptMode || this.draft.attachmentMode;
  }
  private activeId: string | null = null;
  private sessionItems: readonly CommandPaletteItem[] = [];
  private catalogItems: readonly CommandPaletteItem[] = [];
  private sessionSearchRead: { promise: Promise<void> } | undefined;
  private sessionSearchFailed = false;
  private sessionSearchPartial = false;
  private archivedTranscriptsExcluded = 0;
  private sessionSearchIndexing = false;

  private sessionSearchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionSearchId = 0;
  private catalogLoad?: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    agentId: string;
    promise: Promise<void>;
    loadedAt?: number;
  };
  private modelItems: readonly CommandPaletteItem[] = [];
  private modelSearchRead: { promise: Promise<unknown> } | undefined;
  private readonly modelReader = new ModelCatalogReader(
    () => {
      const snapshot = this.modelReader.snapshot;
      if (snapshot.hasSnapshot) {
        this.settledModels = snapshot;
        // Project accepted catalog publications, not every rendering/selection read.
        this.modelItems = getCommandPaletteModelItems(snapshot);
      }
      this.changed();
    },
    {
      onRead: (read) => (this.modelSearchRead = { promise: read.catch(() => undefined) }),
    },
  );
  private settledModels = this.modelReader.snapshot;
  private readonly gateway: GatewayPageBinding;

  constructor(
    private readonly element: HTMLElement,
    private readonly props: CommandPaletteProperties,
    private readonly context: ApplicationContext,
    rendered: () => Promise<unknown>,
    private readonly onDraftInitialized: () => void,
    private readonly publish: () => void,
  ) {
    this.draft = new PaletteSessionDraft(
      element,
      () => ({ context: this.context, open: this.open }),
      {
        changed: this.changed,
        updateComplete: rendered,
        onClose: () => this.closePalette(),
        onOpen: (input) => this.openPalette(input),
        onAttachmentModeChange: () => this.scheduleSessionSearch(this.draft.message),
        onMessageChange: (query) => {
          const text = query.trim();
          const length = Array.from(text).length;
          // Separate entry/exit thresholds keep edits near the boundary from
          // repeatedly collapsing and reopening search. Draft resets pass here too.
          this.textPromptMode =
            text.includes("\n") ||
            (this.textPromptMode ? length > PROMPT_EXIT_CHARS : length >= PROMPT_ENTER_CHARS);
          if (!text) {
            this.filter = "all";
          }
          this.scheduleSessionSearch(query);
        },
      },
    );
    this.gateway = new GatewayPageBinding(this.changed, {
      getGateway: () => this.context?.gateway,
      invalidateRequests: (change) => {
        this.invalidateSessionSearch();
        this.sessionSearchRead = undefined;
        this.catalogLoad = undefined;
        this.modelReader.clear();
        this.modelSearchRead = undefined;
        if (change.identityChanged) {
          this.clearSessionSearch();
          this.clearCatalogSearch();
        } else if (change.snapshot.phase !== "connected") {
          this.scheduleSessionSearch(this.draft.message);
        }
      },
      onSnapshot: () => this.synchronizePresentationScope(),
      ensureInitialData: () => this.scheduleSessionSearch(this.draft.message),
      onPageActivation: () => void this.ensureCatalogItems(),
    });
  }

  readonly handleGatewayEvent: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0] = (
    event,
  ) => {
    const invalidation = modelCatalogEventInvalidation(event);
    const snapshot = this.context?.gateway.snapshot;
    const cron = snapshot && isCronInventoryInvalidation(event, snapshot);
    // Palette search includes skills even when the model cache remains current.
    if (cron || event.event === "chat.metadata.changed" || invalidation) {
      if (invalidation === "clear") {
        this.catalogLoad = undefined;
        this.catalogItems = [];
        this.settledModels = this.modelReader.snapshot;
        this.modelItems = getCommandPaletteModelItems(this.settledModels);
      }
      if (this.open && document.visibilityState !== "hidden") {
        void this.ensureCatalogItems(true);
      } else {
        this.clearCatalogSearch();
      }
    }
  };

  readonly handleAgentSelection = () => {
    this.clearSessionSearch();
    this.clearCatalogSearch();
    this.scheduleSessionSearch(this.draft.message);
  };

  connect() {
    this.connected = true;
    this.draft.connect();
    this.gateway.connect();
    this.changed();
  }

  disconnect() {
    this.connected = false;
    this.initialInput = undefined;
    this.stopInputFocus?.();
    this.stopInputFocus = undefined;
    this.inputElement = undefined;
    this.open = false;
    this.gateway.dispose();
    this.mentionMenu.dispose();
    this.composing = false;
    this.mentionInput = undefined;
    this.activeId = null;
    this.clearSessionSearch();
    this.clearCatalogSearch();
    this.draft.disconnect();
  }

  openPalette(input?: CommandPaletteOpenInput | CommandPaletteInputHandoff) {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A fresh menu is closed; first open can run while Solid mounts the bridge.
    if (this.hasOpened) {
      this.mentionMenu.close();
    }
    this.hasOpened = true;
    this.open = true;
    this.draft.open();
    this.onDraftInitialized();
    this.composing = false;
    this.mentionInput = undefined;
    this.initialInput = input ?? {
      value: this.draft.message,
      selectionStart: this.draft.message.length,
      selectionEnd: this.draft.message.length,
      selectionDirection: "none",
      returnFocus,
    };
    if (typeof this.initialInput !== "function") {
      this.draft.setMessage(this.initialInput.value);
    }
    this.activeId = null;
    this.filter = "all";
    this.scheduleSessionSearch(this.draft.message, false, false);
    this.changed();
  }

  private synchronizePresentationScope() {
    // Retire the draft synchronously with the gateway's presentation scope.
    this.draft.synchronize();
    const gateway = this.context?.gateway;
    const scope = gateway ? gatewayPresentationScope(gateway) : undefined;
    if (this.presentationScope && this.presentationScope !== scope) {
      // Account/connection replacement retires the visible launcher; ordinary
      // transport reconnects keep the canonical presentation scope and query.
      this.closePalette();
      this.activeId = null;
      this.clearCatalogSearch();
    }
    if (
      gateway?.snapshot.phase === "connected" &&
      gateway.snapshot.hello &&
      !hasOperatorReadAccess(gateway.snapshot.hello.auth ?? null)
    ) {
      this.clearSessionSearch();
      this.clearCatalogSearch();
    }
    this.presentationScope = scope;
  }

  readonly togglePalette = () => {
    // A closed launcher keeps custody of an in-flight start and reports its outcome.
    if (!this.open) {
      this.openPalette();
    } else {
      this.closePalette();
    }
  };

  private closePalette() {
    this.mentionMenu.close();
    this.composing = false;
    this.mentionInput = undefined;
    this.initialInput = undefined;
    this.open = false;
    this.draft.close();
    this.clearSessionSearch();
    this.changed();
  }

  private readonly handleInputRef = (
    element: Element | undefined,
    previous?: HTMLTextAreaElement,
  ) => {
    if (previous && previous !== this.inputElement) {
      return;
    }
    this.stopInputFocus?.();
    this.inputElement = element instanceof HTMLTextAreaElement ? element : undefined;
    this.stopInputFocus = this.inputElement
      ? listen(this.inputElement, "focus", this.adoptInitialInput)
      : undefined;
    // The dialog may have focused the field before its committed ref arrived.
    this.adoptInitialInput();
  };

  private readonly adoptInitialInput = () => {
    const element = this.inputElement;
    if (!this.open || !element?.isConnected || document.activeElement !== element) {
      return;
    }
    if (typeof this.initialInput === "function") {
      const take = this.initialInput;
      this.initialInput = undefined;
      const input = take();
      if (!input) {
        this.closePalette();
        return;
      }
      this.initialInput = input;
      this.draft.setMessage(input.value);
      // The dialog has accepted focus. Publish the captured value synchronously
      // before the next key, then let the normal binding retain that same value.
      element.value = input.value;
    }
    const input = this.initialInput;
    if (!input) {
      return;
    }
    this.initialInput = undefined;
    if (input.returnFocus !== undefined) {
      element
        .closest<OpenClawModalDialog>("openclaw-modal-dialog")
        ?.setReturnFocusTarget(input.returnFocus);
    }
    element.setSelectionRange(input.selectionStart, input.selectionEnd, input.selectionDirection);
    if (
      !input.submitRequested &&
      input.mentionTrigger !== undefined &&
      input.selectionStart === input.selectionEnd &&
      input.value.slice(0, input.selectionStart).lastIndexOf("@") === input.mentionTrigger
    ) {
      this.mentionMenu.syncDirectory(this.draft.mentionDirectory);
      this.mentionMenu.update(element, "trigger");
    }
    if (input.attachmentFiles?.length) {
      this.draft.adoptAttachmentFiles(input.attachmentFiles, input.submitRequested);
    } else if (input.submitRequested) {
      this.draft.submitCold();
    }
  };

  private invalidateSessionSearch() {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    this.sessionSearchId += 1;
    this.changed();
  }

  private clearSessionSearch() {
    this.invalidateSessionSearch();
    this.sessionItems = [];
    this.sessionSearchRead = undefined;
    this.sessionSearchFailed = false;
    this.sessionSearchPartial = false;
    this.archivedTranscriptsExcluded = 0;
    this.sessionSearchIndexing = false;
  }

  private clearCatalogSearch() {
    this.modelReader.clear();
    this.modelSearchRead = undefined;
    this.modelItems = [];
    this.settledModels = this.modelReader.snapshot;
    this.catalogLoad = undefined;
    this.catalogItems = [];
    this.pluginIcons.reset();
  }

  private ensureCatalogItems(force = false): Promise<void> {
    const context = this.context;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (
      !this.open ||
      document.visibilityState === "hidden" ||
      this.promptMode ||
      this.mentionMenu.open ||
      this.draft.mentions.length > 0 ||
      !this.gateway.connected ||
      !client
    ) {
      return Promise.resolve();
    }
    const agentId =
      context.agentSelection.state.selectedId ?? resolveUiSelectedGlobalAgentId(gateway.snapshot);
    const current = this.catalogLoad;
    const reuseCatalog =
      !force &&
      current?.client === client &&
      current.agentId === agentId &&
      (current.loadedAt === undefined || Date.now() - current.loadedAt < CATALOG_CACHE_TTL_MS);
    const rebound = this.modelReader.bind(gateway, { agentId });
    if (
      !this.modelReader.pending &&
      ((!reuseCatalog && !force) || rebound || this.modelReader.failed)
    ) {
      void this.modelReader.read();
    }
    if (reuseCatalog) {
      return current.promise;
    }
    const snapshot = gateway.snapshot;
    const scope = gatewayPresentationScope(gateway);
    const promise = loadCommandPaletteCatalogItems({
      client,
      agentId,
      agents: () => context.agents?.ensureList?.() ?? Promise.resolve(null),
      methodAvailable: (method) =>
        hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
        Boolean(isGatewayMethodAdvertised(snapshot, method)),
    }).then((items) => {
      if (
        this.catalogLoad?.promise === promise &&
        gatewayPresentationScope(gateway) === scope &&
        gateway.snapshot.client === client
      ) {
        this.catalogItems = items;
        const eligible = new Set(
          items.flatMap((item) => (item.hasPluginIcon && item.pluginId ? [item.pluginId] : [])),
        );
        this.pluginIcons.reconcileKeys(eligible);
        for (const readId of this.pluginIconTiles) {
          const pluginId = readId();
          if (eligible.has(pluginId)) {
            this.pluginIcons.load(pluginId);
          }
        }
        this.catalogLoad.loadedAt = Date.now();
        this.changed();
      }
    });
    this.catalogLoad = { client, agentId, promise };
    return promise;
  }

  private scheduleSessionSearch(
    query: string,
    immediate = false,
    mentionOpen = this.mentionMenu.open,
  ) {
    // Retire in-flight results immediately, but keep the settled search visible
    // until the typing burst ends. The view disables selection during this pause.
    this.invalidateSessionSearch();
    if (this.promptMode || mentionOpen || this.draft.mentions.length > 0) {
      // Retire catalog generations too: late results and refresh events must not
      // revive search while the same field is being used as a session draft.
      this.clearSessionSearch();
      this.clearCatalogSearch();
      return;
    }
    const search = normalizeOptionalString(query);
    if (!this.open || !search) {
      this.clearSessionSearch();
      this.searchQuery = query;
      this.activeId = null;
      return;
    }
    if (this.composing) {
      return;
    }
    const applySearch = () => {
      if (this.searchQuery !== query) {
        this.clearSessionSearch();
        this.activeId = null;
      }
      this.searchQuery = query;
      if (search.length < SESSION_SEARCH_MIN_CHARS) {
        return;
      }
      void this.ensureCatalogItems();
      if (this.props.onSelectSession) {
        this.sessionSearchRead = { promise: this.searchSessions(search) };
        this.changed();
      }
    };
    if (immediate) {
      applySearch();
    } else {
      this.sessionSearchTimer = globalThis.setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
    }
  }

  private async searchSessions(search: string) {
    const { sessions, gateway } = this.context;
    const client = gateway.snapshot.client;
    if (!sessions || gateway?.snapshot.phase !== "connected" || !client) {
      return;
    }
    const requestId = ++this.sessionSearchId;
    this.sessionSearchFailed = false;
    const scope = gatewayPresentationScope(gateway);
    const isCurrent = () =>
      requestId === this.sessionSearchId &&
      gatewayPresentationScope(gateway) === scope &&
      this.open &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected";
    const transcriptSearch = searchVisibleSessionTranscripts({
      client,
      query: search,
      listOptions: SESSION_SEARCH_SCOPE,
      isCurrent,
    })
      .then((result) => ({ error: false as const, result }))
      .catch(() => ({ error: true as const, result: null }));
    try {
      const result = await sessions.list({
        ...SESSION_SEARCH_SCOPE,
        source: "command-palette",
        search,
        limit: SESSION_SEARCH_LIMIT,
      });
      if (!isCurrent() || !result) {
        return;
      }
      const visibleRows = result.sessions;
      const visibleKeys = new Set(visibleRows.map((row) => row.key));
      const transcriptOutcome = await transcriptSearch;
      if (!isCurrent()) {
        return;
      }
      const transcriptResult = transcriptOutcome.result;
      this.sessionSearchPartial = transcriptOutcome.error;
      this.archivedTranscriptsExcluded = transcriptResult?.archivedTranscriptsExcluded ?? 0;
      this.sessionSearchIndexing = transcriptResult?.indexing === true;
      this.sessionItems = buildCommandPaletteSessionItems({
        visibleRows,
        visibleKeys,
        transcriptResult,
        search,
      });
    } catch {
      // Session search is best-effort; navigation commands stay usable. But a
      // failed search must not render as "No results" — that reads as a
      // successful search with zero matches and hides gateway-side failures
      // (e.g. a store needing doctor migration) from the operator.
      if (isCurrent()) {
        this.sessionSearchFailed = true;
      }
    } finally {
      if (isCurrent()) {
        this.changed();
      }
    }
  }

  readonly handleGlobalKeydown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || !this.element.isConnected || this.composing) {
      return;
    }
    if (!event.defaultPrevented && isCommandPaletteShortcut(event)) {
      event.preventDefault();
      if (!event.repeat) {
        this.togglePalette();
      }
    }
  };

  private updateMentionMenu(event?: InputEvent) {
    this.mentionMenu.syncDirectory(this.draft.mentionDirectory);
    if (!this.mentionMenu.open && !event) {
      return;
    }
    const input = this.inputElement;
    if (
      !input ||
      this.composing ||
      event?.isComposing ||
      event?.inputType === "insertFromPaste" ||
      event?.inputType === "insertFromDrop"
    ) {
      this.mentionMenu.close();
      return;
    }
    this.mentionMenu.update(
      input,
      !event
        ? "selection"
        : event.inputType === "insertText" && event.data?.includes("@") === true
          ? "trigger"
          : "input",
    );
  }

  readProps() {
    const models = this.settledModels;
    return {
      ...this.props,
      basePath: this.context?.basePath ?? "",
      open: this.open,
      query: this.draft.message,
      searchQuery: this.searchQuery,
      searchDebouncing: this.composing || this.draft.message !== this.searchQuery,
      onFlushSearch: () => this.scheduleSessionSearch(this.draft.message, true),
      promptMode: this.promptMode,
      mentionMenu: this.mentionMenu,
      mentionHost: this.mentionHost,
      onMentionChange: this.notifyMentionChange,
      composing: this.composing,
      onBeforeInput: (event: InputEvent) => {
        const input = this.inputElement;
        this.mentionInput = input
          ? {
              value: input.value,
              start: input.selectionStart,
              end: input.selectionEnd,
              inputType: event.inputType,
            }
          : undefined;
      },
      onSelectionChange: () => this.updateMentionMenu(),
      onCompositionStart: () => {
        this.composing = true;
        this.invalidateSessionSearch();
        this.mentionMenu.close();
        this.changed();
      },
      onCompositionEnd: () => {
        this.composing = false;
        const wasOpen = this.mentionMenu.open;
        this.updateMentionMenu();
        // The menu callback handles closes; closed menus still need the IME refresh.
        if (!wasOpen) {
          this.scheduleSessionSearch(this.draft.message);
        }
      },
      activeId: this.activeId,
      filter: this.filter,
      onFilterChange: (filter: PaletteFilter) => {
        this.filter = filter;
        this.activeId = null;
        this.changed();
      },
      agents: this.context?.agents.state.agentsList?.agents ?? [],
      agentIdentity: this.context?.agentIdentity,
      defaultAgentId:
        this.context?.agentSelection.state.selectedId ??
        resolveUiSelectedGlobalAgentId(this.context?.gateway.snapshot ?? {}),
      sessionItems: this.sessionItems,
      remoteSearchOffline:
        !this.gateway.connected && Boolean(normalizeOptionalString(this.searchQuery)),
      modelSearchError:
        this.gateway.connected && this.modelReader.failed ? t("palette.modelSearchFailed") : null,
      primaryModelSearch: models.hasSnapshot && !models.modelSelectionPolicy?.restricted,
      canAdmin: hasOperatorAdminAccess(this.context?.gateway.snapshot.hello?.auth ?? null),
      nativeDeviceSettings: this.context?.nativeDeviceSettings ?? null,
      catalogItems: this.catalogItems,
      modelItems: this.modelItems,
      sessionSearchRead: this.sessionSearchRead,
      catalogSearchRead: this.catalogLoad,
      modelSearchRead: this.modelSearchRead,
      catalogSearchPending:
        Boolean(this.catalogLoad && this.catalogLoad.loadedAt === undefined) ||
        this.modelReader.pending,
      sessionSearchFailed: this.sessionSearchFailed,
      sessionSearchPartial: this.sessionSearchPartial,
      sessionSearchIndexing: this.sessionSearchIndexing,
      archivedTranscriptsExcluded: this.archivedTranscriptsExcluded,
      onToggle: this.togglePalette,
      onQueryChange: (query: string, event: InputEvent) => {
        this.draft.setMessage(
          query,
          updateHumanMentions(this.draft.message, query, this.draft.mentions, this.mentionInput),
        );
        this.mentionInput = undefined;
        this.updateMentionMenu(event);
      },
      onActiveIdChange: (id: string) => {
        this.activeId = id;
        this.changed();
      },
      pluginIconUrls: this.pluginIconUrls,
      onPluginIconError: (pluginId: string) => this.pluginIcons.handleError(pluginId),
      registerPluginIcon: (readId: () => string) => {
        this.pluginIconTiles.add(readId);
        const pluginId = readId();
        if (this.catalogItems.some((item) => item.pluginId === pluginId && item.hasPluginIcon)) {
          this.pluginIcons.load(pluginId);
        }
        return () => this.pluginIconTiles.delete(readId);
      },
      onInputRef: this.handleInputRef,
      draft: this.draft,
    };
  }
}
