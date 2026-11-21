/** Browser-only contract for trusted native Control UI plugins. No host implementation imports. */
import type {
  AgentSummary,
  BoardGetParams,
  SessionRow,
  SessionsListParams,
} from "@openclaw/gateway-protocol";
import type { ControlUiComponents } from "./control-ui-components.js";
export { createSessionHeaderLink } from "./control-ui-session-link.js";
export { translateControlUiMessage } from "./control-ui-translation.js";
export type {
  ControlUiAgentPickerProps,
  ControlUiComponentHandle,
  ControlUiComponents,
  ControlUiDashboardProps,
  ControlUiDialogProps,
} from "./control-ui-components.js";
export type { AgentsWorkspaceGetResult } from "@openclaw/gateway-protocol";
export type { MemorySearchResponse } from "../../packages/memory-host-sdk/src/host/types.js";
export type ControlUiDisposer = () => void;

/** Tab-local recovery data bound to this authenticated Gateway account and plugin. */
export type ControlUiRecoveryStorageV1 = {
  readonly version: 1;
  /** Throws after account, connection, activation, or view retirement. */
  assertCurrent: () => void;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type ControlUiConnection = {
  connected: boolean;
  canRead: boolean;
  canWrite: boolean;
  canGrant: boolean;
  canAdmin: boolean;
  assistantAgentId: string | null;
};

export type ControlUiSession = Readonly<
  SessionRow & {
    /** Live activity from the Control UI session owner; absent while activity is unknown. */
    hasActiveRun?: boolean;
  }
>;

export type ControlUiSessionListQuery = Readonly<
  Pick<
    SessionsListParams,
    | "agentId"
    | "search"
    | "archived"
    | "limit"
    | "configuredAgentsOnly"
    | "includeGlobal"
    | "includeUnknown"
    | "excludeDock"
    | "includeDerivedTitles"
    | "includeLastMessage"
  >
>;

export type ControlUiSessionListResult = {
  readonly sessions: readonly ControlUiSession[];
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
  readonly totalCount?: number;
};

export type ControlUiSessionListSnapshot = {
  readonly result: ControlUiSessionListResult | null;
  readonly loading: boolean;
  readonly error: string | null;
};

export type ControlUiSessionListSubscription = {
  /** Fetch again; rejects on failure or when this query's lifetime has ended. */
  refresh: () => Promise<void>;
  dispose: ControlUiDisposer;
};

export type ControlUiAgent = Readonly<AgentSummary>;
export type ControlUiPageTarget = {
  id: string;
  params?: Readonly<Record<string, string>>;
  /** Unescaped path segments for a page with an advertised native route placement. */
  path?: readonly string[];
};
export type ControlUiPageNavigationOptions = {
  /** Replace the current history entry when canonicalizing a page or changing its filters. */
  replace?: boolean;
  /** Retain the current query, with target parameters taking precedence. */
  preserveSearch?: boolean;
};

export type ControlUiSurfaceProps = {
  "session-list": BoardGetParams & { sessions: readonly ControlUiSession[] };
  composer: BoardGetParams & {
    agentId: string;
    draft: string;
    canSend: boolean;
    sending: boolean;
    disabledReason: string | null;
    setDraft: (text: string) => void;
    /** Resolves true on admission, false on rejection, or void for a local command/no submit. */
    send: () => Promise<boolean | void>;
    abort?: () => void;
  };
  workspace: BoardGetParams & { routeId: string };
  transcript: BoardGetParams & {
    messages: readonly unknown[];
    stream: string | null;
    loading: boolean;
  };
  /** Only the feedback action/receipt beside a terminal run failure, not its details or recovery. */
  "run-failure-feedback": BoardGetParams & {
    /** The exact displayed failure, including when adjacent failures are grouped. */
    runId: string;
    repeatCount: number;
  };
  "tool-result": BoardGetParams & {
    toolName: string;
    toolCallId: string;
    input: unknown;
    output: unknown;
    expanded: boolean;
  };
};

export type ControlUiSurface = keyof ControlUiSurfaceProps;

export type ControlUiViewContext<T = Readonly<Record<string, string>>> = {
  readonly host: ControlUiHost;
  readonly signal: AbortSignal;
  readonly props: T;
  /** Report a fatal mount failure; the host disposes this instance and offers Retry. */
  reportError?: (error: unknown) => void;
  /** Presentation can pause a retained view without ending its host lifetime. */
  readonly presented: boolean;
  /** Mount the host's built-in view inside a replacement; it keeps receiving host updates. */
  mountDefault: (container: HTMLElement) => ControlUiDisposer;
};

export type ControlUiView<T = Readonly<Record<string, string>>> = (
  container: HTMLElement,
  context: ControlUiViewContext<T>,
) => {
  update?: (context: ControlUiViewContext<T>) => void;
  focus?: () => void;
  dispose?: ControlUiDisposer;
} | void;

export type ControlUiPage = {
  id: string;
  label: string;
  mount: ControlUiView;
};

type ControlUiNavigationAction = {
  id: string;
  label: string;
  icon?: string;
  destructive?: boolean;
  run: () => void | Promise<void>;
};

export type ControlUiNavigationItem = {
  id: string;
  /** Navigation item ID in this plugin whose active section displays this child. */
  parent?: string;
  label: string;
  page: ControlUiPageTarget;
  icon?: string;
  order?: number;
  /** False offers the destination in the pin editor without adding it to the sidebar. */
  defaultVisible?: boolean;
  /** Context menu actions, available by right-click or the keyboard menu shortcut. */
  actions?: ControlUiNavigationAction[];
};

/** A predefined installed renderer. Payload is data, never a generated template. */
type ControlUiInlineView = {
  id: string;
  /** Exact component/payload interface version (1–65535), not the package version. */
  version: number;
  mount: ControlUiView<
    BoardGetParams & {
      payload: import("../plugins/host-hook-json.js").PluginJsonValue;
      toolCallId: string;
      toolName: string;
    }
  >;
};

export type ControlUiPanel = {
  id: string;
  label: string;
  /** Fixed host icon-registry name; unknown/omitted names fall back to plug. Manifest SVG artwork takes precedence. */
  icon?: string;
  mount: ControlUiView<BoardGetParams>;
};

/** A draft offered to the user beside the composer; nothing changes until they accept it. */
export type ControlUiDraftProposal = {
  /** Short heading for the proposal card. */
  title: string;
  /**
   * Replace the draft at once instead of waiting for Use: one editor change with an Undo
   * receipt, never sent. While dictation or a pending goal locks the editor, the proposal waits
   * for Use as usual. Resolves `"accepted"` once the draft is replaced.
   */
  insert?: boolean;
  /**
   * Insert the text, then send it as if the user pressed Enter: the same admission, follow-up
   * queueing and checks. When the composer cannot send now (disconnected, a pending attachment)
   * the inserted draft stays unsent with its Undo receipt; a locked editor keeps the proposal
   * for Use, as with `insert`. Implies `insert`.
   */
  send?: boolean;
};

/** The user's choice; `"dismissed"` also covers the pane, chat, or action retiring first. */
export type ControlUiDraftProposalOutcome = "accepted" | "dismissed";

/** One line of a running composer task's progress, such as a tool call. */
export type ControlUiComposerTaskStep = {
  label: string;
  state: "running" | "done" | "failed";
};

/**
 * Work an action runs for the composer, shown by the host in one card above the input:
 * working, then a proposal or a failure, without moving the composer. The card leaves when the
 * task settles, the user cancels, the chat changes, or the action's `signal` aborts.
 */
export type ControlUiComposerTask = {
  /** Aborts when the user cancels the task or the action retires. */
  readonly signal: AbortSignal;
  /** Replace the working card's progress: the newest steps and an optional summary. */
  update: (progress: { steps?: readonly ControlUiComposerTaskStep[]; summary?: string }) => void;
  /** Turn the card into a proposal of `text`; resolves when the user chooses. */
  propose: (
    text: string,
    proposal: ControlUiDraftProposal,
  ) => Promise<ControlUiDraftProposalOutcome>;
  /** Show a failure in the card; the user can dismiss it or run the action again. */
  fail: (message: string) => void;
};

export type ControlUiComposerHandle = {
  readonly draft: string;
  setDraft: (text: string) => void;
  /**
   * Start a task card titled `title`. While it runs, the invoking composer action shows as
   * pressed, and its Cancel aborts `task.signal`. Starting another task replaces this one.
   * `startedAt` (epoch ms) keeps the elapsed clock of work resumed from `attach`.
   */
  startTask: (options: { title: string; startedAt?: number }) => ControlUiComposerTask;
  /**
   * Offer `text` as a replacement draft without a working phase. The user accepts it (Use or
   * Tab) or dismisses it (Dismiss or Escape); it is never sent. Accepting replaces the draft as
   * one editor change, so undo restores the previous draft, including mentions.
   */
  propose: (
    text: string,
    proposal: ControlUiDraftProposal,
  ) => Promise<ControlUiDraftProposalOutcome>;
};

export type ControlUiAction = {
  id: string;
  label: string;
  placement: "composer" | "header" | "session";
  /**
   * Fixed host icon-registry name. A composer action with an icon renders as a compact
   * toolbar button beside the attachment menu, named and tooltipped by its label.
   */
  icon?: string;
  resolve?: (
    context: BoardGetParams & {
      session?: ControlUiSession;
      /** Composer placement only: the pane's current draft, so an action can need text. */
      draft?: string;
    },
  ) => {
    label?: string;
    disabled?: boolean;
    hidden?: boolean;
  };
  run: (
    context: BoardGetParams & {
      session?: ControlUiSession;
      host: ControlUiHost;
      signal: AbortSignal;
      /** Composer placement only: the invoking pane's live draft; retires with `signal`. */
      composer?: ControlUiComposerHandle;
    },
  ) => void | Promise<void>;
  /**
   * Composer placement only. Called each time a built-in composer shows this chat (mount,
   * chat switch, return from another page), with the same context as `run`, so the action
   * can show work it started earlier that is still running or finished while the user was
   * away: start a task again and follow it. Return at once when there is none. Leaving the
   * chat aborts `signal` and retires the card; keep the work itself going, and stop it only
   * when the task's own signal aborts while `signal` has not (the user pressed Cancel).
   */
  attach?: ControlUiAction["run"];
};

export type ControlUiAccessory = {
  id: string;
  placement: "session-header";
  mount: ControlUiView<BoardGetParams>;
};

export type ControlUiWidget = {
  id: string;
  label: string;
  mount: ControlUiView<
    BoardGetParams & {
      widget: { name: string; props?: Readonly<Record<string, unknown>> };
      canMutate: boolean;
      canGrant: boolean;
    }
  >;
};

export type ControlUiReplacement<S extends ControlUiSurface = ControlUiSurface> = {
  [Surface in S]: {
    id: string;
    label: string;
    surface: Surface;
    mount: ControlUiView<ControlUiSurfaceProps[Surface]>;
  };
}[S];

export type ControlUiHost = {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly basePath: string;
  readonly locale: string;
  redact: (text: string) => string;
  readonly connection: ControlUiConnection;
  /** Absent or null until the authenticated recovery owner is available. Storage errors throw. */
  readonly recoveryStorage?: ControlUiRecoveryStorageV1 | null;
  readonly components: ControlUiComponents;
  /**
   * Native modules share the operator's authenticated Gateway authority.
   * The Gateway enforces connection scopes, not a per-plugin RPC allowlist.
   */
  request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /**
   * `session.message` listeners receive complete message bodies. Registration is
   * synchronous, but delivery starts after the Gateway acknowledges full-body
   * interest. In-flight roster events without bodies are skipped during admission;
   * the host never delivers a bodyless `session.message` to a plugin listener.
   */
  onEvent: (event: string, listener: (payload: unknown) => void) => ControlUiDisposer;
  subscribe: (listener: () => void) => ControlUiDisposer;
  sessions: {
    /** The current application roster may be filtered and paginated. */
    readonly rows: readonly ControlUiSession[];
    readonly selectedKey: string;
    normalizeKey: (sessionKey: string) => string;
    refresh: () => Promise<void>;
    /** Fetch and observe an independent query; the first snapshot may have no result. */
    observe: (
      query: ControlUiSessionListQuery,
      listener: (snapshot: ControlUiSessionListSnapshot) => void,
    ) => ControlUiSessionListSubscription;
    open: (session: BoardGetParams) => void;
    create: (params?: {
      agentId?: string;
      label?: string;
      /** Presentation title without a unique label claim. */
      displayName?: string;
      /** Immutable dock surface; preserves the authenticated operator's creator identity. */
      surface?: "plugin-dock";
    }) => Promise<string | null>;
    patch: (
      session: BoardGetParams,
      patch: { label?: string; model?: string | null },
    ) => Promise<void>;
  };
  agents: {
    readonly rows: readonly ControlUiAgent[];
    readonly selectedId: string | null;
    readonly defaultId: string | null;
    readonly scopeId: string | null;
    select: (agentId: string) => void;
    setScope: (agentId: string | null) => void;
    refresh: () => Promise<void>;
  };
  dock?: {
    /** Dock a conversation beside the current page; replaces a conversation dock already open. */
    openSession: (params: {
      sessionKey: string;
      agentId: string;
      /** Dock tab title. */
      label: string;
      /** Untrusted ambient reference data, never instructions or access authority. */
      context?: { page: string; detail?: Readonly<Record<string, string>> };
    }) => void;
    close: () => void;
    readonly openSessionKey: string | null;
  };
  navigation: {
    openPage: (target: ControlUiPageTarget, options?: ControlUiPageNavigationOptions) => void;
    pageHref: (
      target: ControlUiPageTarget,
      options?: Pick<ControlUiPageNavigationOptions, "preserveSearch">,
    ) => string;
  };
  ui: {
    /** Refresh contributions whose presentation depends on plugin-owned state. */
    invalidate: () => void;
    registerPage: (page: ControlUiPage) => ControlUiDisposer;
    registerNavigation: (item: ControlUiNavigationItem) => ControlUiDisposer;
    /** Pin an already registered navigation item once; unknown or pinned IDs are a no-op. */
    pinNavigation: (id: string) => void;
    /** Remove this plugin's saved navigation pin; an absent pin is a no-op. */
    unpinNavigation: (id: string) => void;
    /** Whether this plugin's navigation ID is in the saved sidebar entries. */
    isNavigationPinned: (id: string) => boolean;
    registerPanel: (panel: ControlUiPanel) => ControlUiDisposer;
    /** Open an owned registered panel beside the supplied or currently selected session. */
    openPanel: (id: string, session?: BoardGetParams) => void;
    registerAction: (action: ControlUiAction) => ControlUiDisposer;
    registerAccessory: (accessory: ControlUiAccessory) => ControlUiDisposer;
    registerWidget: (widget: ControlUiWidget) => ControlUiDisposer;
    registerInlineView: (view: ControlUiInlineView) => ControlUiDisposer;
    registerReplacement: (replacement: ControlUiReplacement) => ControlUiDisposer;
    /** Select an owned replacement, or restore the built-in view for this surface. */
    selectReplacement: (surface: ControlUiSurface, id: string | null) => void;
  };
};

export type ControlUiPlugin = {
  id: string;
  activate: (host: ControlUiHost) => void | ControlUiDisposer | Promise<void | ControlUiDisposer>;
};

export function defineControlUiPlugin(plugin: ControlUiPlugin): ControlUiPlugin {
  return plugin;
}
export type { DoctorMemoryStatusPayload } from "../../packages/gateway-protocol/src/doctor-memory.js";
export type {
  ControlUiSettingsPlacement,
  ControlUiSettingsSnapshot,
  ControlUiSettingsComponents,
  ControlUiSettingsContext,
  ControlUiSettingsView,
  ControlUiChannelSettingsSnapshot,
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsView,
} from "./control-ui-settings.js";
