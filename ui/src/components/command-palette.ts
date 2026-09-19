// The palette owns search/navigation; its draft reuses the canonical session owners.
import { consume } from "@lit/context";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { resolveUiSelectedGlobalAgentId } from "../lib/sessions/session-key.ts";
import { searchVisibleSessionTranscripts } from "../lib/sessions/transcript-search.ts";
import { GatewayPageController } from "../lit/gateway-page-controller.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { PaletteSessionDraft } from "../pages/new-session/palette-session-draft.ts";
import {
  getStaticCommandPaletteCatalogItems,
  loadCommandPaletteCatalogItems,
  toCommandPaletteItems,
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
} from "./command-palette-session-search.ts";
import { renderCommandPalette, type PaletteFilter } from "./command-palette-view.ts";
import type { OpenClawModalDialog } from "./modal-dialog.ts";

type PaletteItem = CommandPaletteItem;

const SESSION_SEARCH_DEBOUNCE_MS = 50;
const SESSION_SEARCH_MIN_CHARS = 2;
// sessions.search caps queries at 4,096 Unicode characters; session prompts are independent.
const SESSION_SEARCH_MAX_CHARS = 4_096;

function exceedsSessionSearchLimit(query: string): boolean {
  return Array.from(query).length > SESSION_SEARCH_MAX_CHARS;
}
const SESSION_SEARCH_SCOPE = {
  includeGlobal: false,
  includeUnknown: false,
  configuredAgentsOnly: true,
  excludeSubagents: true,
  excludeCron: true,
  excludeSystem: true,
} as const;
const CATALOG_CACHE_TTL_MS = 30_000;

export class CommandPalette extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) onNavigate?: ApplicationContext["navigate"];
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;
  @property({ attribute: false }) onSlashCommand?: (command: string) => void;
  @property({ attribute: false }) desktopAvailable = false;
  @property({ attribute: false }) custodianAvailable = false;
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @state() private open = false;
  private initialInput: CommandPaletteOpenInput | undefined;
  private takeInitialInput: CommandPaletteInputHandoff | undefined;
  private inputElement: HTMLTextAreaElement | undefined;
  private presentationScope: ReturnType<typeof gatewayPresentationScope> | undefined;
  @state() private filter: PaletteFilter = "all";
  private readonly draft = new PaletteSessionDraft(
    this,
    () => ({ context: this.context, open: this.open }),
    {
      onClose: () => this.closePalette(),
      onMessageChange: (query) => {
        if (!query.trim()) {
          this.filter = "all";
        }
        this.activeId = null;
        this.scheduleSessionSearch(query);
      },
    },
  );

  private get query(): string {
    return this.draft.message;
  }
  @state() private activeId: string | null = null;
  @state() private sessionItems: readonly PaletteItem[] = [];
  @state() private catalogItems: readonly PaletteItem[] = [];
  @state() private modelSearchError: string | null = null;
  @state() private sessionSearchPending = false;
  @state() private sessionSearchFailed = false;
  @state() private sessionSearchPartial = false;
  @state() private archivedTranscriptsExcluded = 0;
  @state() private sessionSearchIndexing = false;

  private readonly subscriptions = new SubscriptionsController(this);
  @state() private sessionSearchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionSearchId = 0;
  @state() private catalogLoad?: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    agentId: string;
    promise: Promise<void>;
    loadedAt?: number;
  };
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.clearSessionSearch();
      this.clearCatalogSearch();
    },
    onSnapshot: () => this.synchronizePresentationScope(),
    ensureInitialData: () => this.scheduleSessionSearch(this.query),
  });

  constructor() {
    super();
    this.subscriptions.effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (
            this.context?.gateway === gateway &&
            (event.event === "config.changed" || event.event === "chat.metadata.changed")
          ) {
            if (this.open) {
              void this.ensureCatalogItems(true);
            } else {
              this.clearCatalogSearch();
            }
          }
        }),
    );
    this.subscriptions.watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => {
        this.clearCatalogSearch();
        this.scheduleSessionSearch(this.query);
      },
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleGlobalKeydown);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleGlobalKeydown);
    this.initialInput = undefined;
    this.takeInitialInput = undefined;
    this.inputElement?.removeEventListener("focus", this.adoptInitialInput);
    this.inputElement = undefined;
    this.open = false;
    this.activeId = null;
    this.clearSessionSearch();
    this.clearCatalogSearch();
    super.disconnectedCallback();
  }

  openPalette(input?: CommandPaletteOpenInput | CommandPaletteInputHandoff) {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.open = true;
    this.draft.open();
    this.takeInitialInput = typeof input === "function" ? input : undefined;
    this.initialInput =
      typeof input === "function"
        ? undefined
        : (input ?? {
            value: this.query,
            selectionStart: this.query.length,
            selectionEnd: this.query.length,
            selectionDirection: "none",
            returnFocus,
          });
    if (this.initialInput) {
      this.draft.setMessage(this.initialInput.value);
    }
    this.activeId = null;
    this.filter = "all";
    this.scheduleSessionSearch(this.query);
  }

  private synchronizePresentationScope() {
    const gateway = this.context?.gateway;
    const scope = gateway ? gatewayPresentationScope(gateway) : undefined;
    if (this.presentationScope && this.presentationScope !== scope) {
      // Account/connection replacement retires the visible launcher; ordinary
      // transport reconnects keep the canonical presentation scope and query.
      this.closePalette();
      this.activeId = null;
      this.clearCatalogSearch();
    }
    this.presentationScope = scope;
  }

  get isOpen(): boolean {
    return this.open;
  }

  readonly togglePalette = () => {
    if (this.open) {
      if (!this.draft.submitting) {
        this.closePalette();
      }
      return;
    }
    this.openPalette();
  };

  private closePalette() {
    this.initialInput = undefined;
    this.takeInitialInput = undefined;
    this.open = false;
    this.draft.close();
    this.clearSessionSearch();
  }

  private readonly handleInputRef = (element: Element | undefined) => {
    this.inputElement?.removeEventListener("focus", this.adoptInitialInput);
    this.inputElement = element instanceof HTMLTextAreaElement ? element : undefined;
    this.inputElement?.addEventListener("focus", this.adoptInitialInput);
  };

  private readonly adoptInitialInput = () => {
    const element = this.inputElement;
    if (!this.open || !element?.isConnected || document.activeElement !== element) {
      return;
    }
    if (this.takeInitialInput) {
      const take = this.takeInitialInput;
      this.takeInitialInput = undefined;
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
    if (input.submitRequested) {
      void this.draft.submit();
    }
  };

  protected override updated() {
    // ModalDialog owns autofocus. Focusing its not-yet-open slotted field here
    // can retire the loader before the browser has admitted the new modal.
    this.adoptInitialInput();
  }

  private clearSessionSearch() {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    this.sessionSearchId += 1;
    this.sessionItems = [];
    this.sessionSearchPending = false;
    this.sessionSearchFailed = false;
    this.sessionSearchPartial = false;
    this.archivedTranscriptsExcluded = 0;
    this.sessionSearchIndexing = false;
  }

  private clearCatalogSearch() {
    this.catalogLoad = undefined;
    this.catalogItems = [];
    this.modelSearchError = null;
  }

  private ensureCatalogItems(force = false): Promise<void> {
    const context = this.context;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!context || !this.gateway.connected || !gateway || !client) {
      return Promise.resolve();
    }
    const agentId =
      context.agentSelection.state.selectedId ?? resolveUiSelectedGlobalAgentId(gateway.snapshot);
    const current = this.catalogLoad;
    if (
      !force &&
      current?.client === client &&
      current.agentId === agentId &&
      (current.loadedAt === undefined || Date.now() - current.loadedAt < CATALOG_CACHE_TTL_MS)
    ) {
      return current.promise;
    }
    const snapshot = gateway.snapshot;
    const scope = gatewayPresentationScope(gateway);
    const previousModels =
      current?.client === client && current.agentId === agentId
        ? this.catalogItems.filter((item) => item.category === "models")
        : [];
    const promise = loadCommandPaletteCatalogItems({
      client,
      agentId,
      agents: () => context.agents?.ensureList?.() ?? Promise.resolve(null),
      methodAvailable: (method) => Boolean(isGatewayMethodAdvertised(snapshot, method)),
    }).then(({ items, modelRequestFailed, modelSearchError }) => {
      if (
        this.catalogLoad?.promise === promise &&
        gatewayPresentationScope(gateway) === scope &&
        this.context?.gateway === gateway &&
        this.context?.agentSelection === context.agentSelection &&
        gateway.snapshot.client === client
      ) {
        this.catalogItems = [
          ...toCommandPaletteItems(items),
          ...(modelRequestFailed ? previousModels : []),
        ];
        this.modelSearchError = modelSearchError;
        this.catalogLoad = { ...this.catalogLoad, loadedAt: modelRequestFailed ? 0 : Date.now() };
      }
    });
    this.catalogLoad = { client, agentId, promise };
    return promise;
  }

  private scheduleSessionSearch(query: string) {
    // Invalidate the previous query immediately so late responses cannot
    // repopulate selectable stale rows during the debounce window.
    this.clearSessionSearch();
    const search = normalizeOptionalString(query);
    if (
      !this.open ||
      !search ||
      search.length < SESSION_SEARCH_MIN_CHARS ||
      exceedsSessionSearchLimit(search)
    ) {
      return;
    }
    this.sessionSearchPending = Boolean(
      this.onSelectSession && this.context?.sessions && this.gateway.connected,
    );
    this.sessionSearchTimer = globalThis.setTimeout(() => {
      this.sessionSearchTimer = null;
      void this.ensureCatalogItems();
      if (this.onSelectSession) {
        void this.searchSessions(search);
      } else {
        this.sessionSearchPending = false;
      }
    }, SESSION_SEARCH_DEBOUNCE_MS);
  }

  private async searchSessions(search: string) {
    const context = this.context;
    const sessions = context?.sessions;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!sessions || gateway?.snapshot.phase !== "connected" || !client) {
      this.sessionSearchPending = false;
      return;
    }
    const requestId = ++this.sessionSearchId;
    const scope = gatewayPresentationScope(gateway);
    const isCurrent = () =>
      requestId === this.sessionSearchId &&
      gatewayPresentationScope(gateway) === scope &&
      this.open &&
      this.context?.sessions === sessions &&
      this.context?.gateway === gateway &&
      this.context?.agentSelection === context?.agentSelection &&
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
        this.sessionSearchPending = false;
      }
    }
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return;
    }
    if (isCommandPaletteShortcut(event)) {
      event.preventDefault();
      this.togglePalette();
    }
  };

  override render() {
    return renderCommandPalette({
      basePath: this.context?.basePath ?? "",
      open: this.open,
      query: this.query,
      activeId: this.activeId,
      filter: this.filter,
      onFilterChange: (filter) => {
        this.filter = filter;
        this.activeId = null;
      },
      agents: this.context?.agents.state.agentsList?.agents ?? [],
      agentIdentity: this.context?.agentIdentity,
      defaultAgentId:
        this.context?.agentSelection.state.selectedId ??
        resolveUiSelectedGlobalAgentId(this.context?.gateway.snapshot ?? {}),
      sessionItems: this.sessionItems,
      modelSearchError: this.modelSearchError,
      catalogItems: [
        ...toCommandPaletteItems(
          getStaticCommandPaletteCatalogItems(
            hasOperatorAdminAccess(this.context?.gateway.snapshot.hello?.auth ?? null),
            this.context?.nativeDeviceSettings,
          ),
        ),
        ...this.catalogItems,
      ],
      sessionSearchPending: this.sessionSearchPending,
      searchLimitReached: exceedsSessionSearchLimit(this.query.trim()),
      catalogSearchPending: Boolean(
        normalizeOptionalString(this.query) &&
        !exceedsSessionSearchLimit(this.query.trim()) &&
        ((this.sessionSearchTimer !== null && this.gateway.connected) ||
          (this.catalogLoad && this.catalogLoad.loadedAt === undefined)),
      ),
      sessionSearchFailed: this.sessionSearchFailed,
      sessionSearchPartial: this.sessionSearchPartial,
      sessionSearchIndexing: this.sessionSearchIndexing,
      archivedTranscriptsExcluded: this.archivedTranscriptsExcluded,
      desktopAvailable: this.desktopAvailable,
      custodianAvailable: this.custodianAvailable,
      onToggle: this.togglePalette,
      onQueryChange: (query) => {
        this.draft.setMessage(query);
      },
      onActiveIdChange: (id) => {
        this.activeId = id;
      },
      onNavigate: this.onNavigate,
      onSelectSession: this.onSelectSession,
      onSlashCommand: this.onSlashCommand,
      onInputRef: this.handleInputRef,
      draft: this.draft,
    });
  }
}

if (!customElements.get("openclaw-command-palette")) {
  customElements.define("openclaw-command-palette", CommandPalette);
}
