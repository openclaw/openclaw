/** Browser-only contract for trusted native Control UI plugins. No host implementation imports. */

import type {
  AgentSummary,
  BoardGetParams,
  SessionRow,
  SessionsListParams,
} from "@openclaw/gateway-protocol";
import type { ControlUiComponents } from "./control-ui-components.js";
import type { ControlUiPresentationHost } from "./control-ui-presentation.js";
import type { ControlUiRequests } from "./control-ui-requests.js";
import type {
  ControlUiSessionOperationBinding,
  ControlUiSessionOperationFactory,
} from "./control-ui-session-operation.js";

export type {
  ControlUiRequests,
  ControlUiCapturedRequest,
  ControlUiSetSync,
  ControlUiSetSyncOptions,
} from "./control-ui-requests.js";
export type {
  ControlUiSessionOperationOwner,
  ControlUiSessionOperation,
  ControlUiSessionOperationFactory,
  ControlUiSessionOperationBinding,
} from "./control-ui-session-operation.js";
export { createSessionHeaderLink } from "./control-ui-session-link.js";
export { generateUUID } from "../../packages/normalization-core/src/uuid.js";
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

export type ControlUiConnection = {
  connected: boolean;
  /** Opaque invalidation identity for authorized read projections, never authority. */
  readonly readScopeKey?: string;
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
  mount: ControlUiView<BoardGetParams>;
};

export type ControlUiAction = {
  id: string;
  label: string;
  placement: "composer" | "header" | "session";
  icon?: string;
  shortcut?: string;
  opensExternal?: boolean;
  /** Display-scoped interest; cleanup ends delivery and releases read interest. */
  observe?: (
    context: BoardGetParams & { session?: ControlUiSession; signal: AbortSignal },
    changed: () => void,
  ) => ControlUiDisposer;
  resolve?: (context: BoardGetParams & { session?: ControlUiSession }) => {
    label?: string;
    disabled?: boolean;
    hidden?: boolean;
  };
  run: (
    context: BoardGetParams & {
      session?: ControlUiSession;
      host: ControlUiHost;
      signal: AbortSignal;
    },
  ) => void | Promise<void>;
};

/** Offsets address UTF-16 code units in one prose run, excluding code and existing links. */
export type ControlUiTextReference = Readonly<{
  start: number;
  end: number;
  url: string;
  label?: string;
}>;
export type ControlUiTextReferenceInput = {
  text: string;
  links: readonly string[];
};
/** Capture immutable facts; publish a new object when resolution changes, even if key is unchanged. */
export type ControlUiTextReferenceSnapshot = Readonly<{
  /** Deterministic identity of the immutable facts captured by resolve. */
  key: string;
  resolve: (input: ControlUiTextReferenceInput) => readonly ControlUiTextReference[];
}>;
export type ControlUiTextReferenceProvider = {
  id: string;
  /** Presentation requires this exact admitted reader; its plugin retains ownership. */
  reader: Readonly<{ pluginId: string; id: string }>;
  snapshot: (context: BoardGetParams) => ControlUiTextReferenceSnapshot;
  observe?: (
    context: BoardGetParams & { signal: AbortSignal },
    changed: () => void,
  ) => ControlUiDisposer;
};

export type ControlUiSessionHeaderFacts = {
  /** Recheck pane-held authority before acting, including deferred projections. */
  readCurrent?: () => ControlUiSessionHeaderFacts | undefined;
  session?: ControlUiSession;
  participationBlocked: boolean;
  hasActiveRun: boolean;
  workspaceReady: boolean;
  workspaceConflict: boolean;
};
export type ControlUiAccessoryProps = BoardGetParams & {
  /** Existing physical checkout identity; absent for catalog-only session facts. */
  worktreeId?: string;
  facts?: ControlUiSessionHeaderFacts;
  /** Opaque facts produced and recognized by the contributing plugin. */
  artifact?: unknown;
  /** Report logical content presence; the containing slot stays mounted to receive future facts. */
  onPresenceChange?: (present: boolean) => void;
  /** Bracket asynchronous child rendering so the host preserves focus and overlay geometry. */
  onContentChange?: (phase: "before" | "after") => void;
  compact?: boolean;
  dismissed?: boolean;
  onOpenSessionDiff?: () => void;
  /** Opaque contributed page within the native mobile Details history. */
  detailsPage?: string;
  /** Navigation only; the host retains Root, Back, focus and presentation ownership. */
  onOpenDetailsPage?: (page: { id: string; title: string }, source?: HTMLElement) => void;
  onDetailsBack?: () => void;
  /** Contribute controls to the containing surface's existing keyboard traversal. */
  registerControls?: (read: () => readonly HTMLElement[]) => ControlUiDisposer;
};
export type ControlUiAccessory = {
  id: string;
  placement: "session-header";
  mount: ControlUiView<BoardGetParams>;
};

/** Passive display facts; never HTML, actions, module metadata, or request authority. */
export type ControlUiSessionBadge = Readonly<{
  icon: string;
  label: string;
  count?: number;
  tone?: "muted" | "positive" | "negative" | "accent" | "violet";
  /** Plain display state, exposed as data-<accessory id>-state alongside the badge. */
  state?: string;
}>;
export type ControlUiSessionBadgeTarget = Pick<
  ControlUiAccessoryProps,
  "sessionKey" | "agentId" | "worktreeId" | "artifact"
>;
export type ControlUiSessionBadgeAccessory = {
  id: string;
  placement: "session-row";
  presentation: "badge";
  /** The same synchronous projection supplies native live rendering and the sidebar snapshot. */
  resolve: (
    target: ControlUiSessionBadgeTarget,
  ) => { status: "pending" } | { status: "ready"; badge?: ControlUiSessionBadge };
  observe?: (
    target: ControlUiSessionBadgeTarget & { signal: AbortSignal },
    changed: () => void,
  ) => ControlUiDisposer;
};

export type ControlUiSessionAccessory = {
  id: string;
  placement:
    | "session-header"
    | "session-context"
    | "session-environment"
    | "session-row"
    | "session-hovercard"
    | "session-activity"
    | "session-summary"
    | "session-mobile-root"
    | "session-mobile-page"
    | "session-mobile-activity";
  mount: ControlUiViewV2<ControlUiAccessoryProps>;
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

export type ControlUiActionV2 = Omit<ControlUiAction, "run"> & {
  run: (
    context: Omit<Parameters<ControlUiAction["run"]>[0], "host"> & { host: ControlUiHostV2 },
  ) => void | Promise<void>;
};

export type ControlUiPageV2 = Omit<ControlUiPage, "mount"> & { mount: ControlUiViewV2 };
export type ControlUiPanelV2 = Omit<ControlUiPanel, "mount"> & {
  mount: ControlUiViewV2<BoardGetParams>;
};
export type ControlUiWidgetV2 = Omit<ControlUiWidget, "mount"> & {
  mount: ControlUiViewV2<Parameters<ControlUiWidget["mount"]>[1]["props"]>;
};
export type ControlUiReplacementV2<S extends ControlUiSurface = ControlUiSurface> = {
  [Surface in S]: Omit<ControlUiReplacement<Surface>, "mount"> & {
    mount: ControlUiViewV2<ControlUiSurfaceProps[Surface]>;
  };
}[S];

/** Opt-in host capabilities; legacy plugins retain apiVersion 1 and their original source contract. */
export type ControlUiHostV2 = Omit<ControlUiHost, "sessions" | "navigation" | "ui"> & {
  readonly capabilitiesVersion: 2;
  readonly requests: ControlUiRequests;
  readonly native?: import("./control-ui-native.js").ControlUiNativeHost;
  readonly presentation?: ControlUiPresentationHost;
  sessions: ControlUiHost["sessions"] & {
    methodAccess: (
      row: ControlUiSession,
      request: {
        method: string;
        requiredScope?:
          | "operator.admin"
          | "operator.read"
          | "operator.write"
          | "operator.sessions.read"
          | "operator.sessions.write"
          | "operator.approvals"
          | "operator.pairing";
        sessionScope?: boolean;
      },
    ) => boolean;
    attachOperation: <TBinding extends object>(
      row: ControlUiSession,
      factory: ControlUiSessionOperationFactory<TBinding>,
    ) => ControlUiSessionOperationBinding<TBinding> | null;
    artifactKey: (target: BoardGetParams) => string;
    agentId: (key: string) => string | undefined;
    matches: (target: BoardGetParams, eventKey: string, eventAgentId?: string | null) => boolean;
  };
  navigation: ControlUiHost["navigation"] & {
    openExternal: (url: string) => void;
  };
  ui: Omit<
    ControlUiHost["ui"],
    | "registerPage"
    | "registerPanel"
    | "registerWidget"
    | "registerReplacement"
    | "registerAccessory"
    | "registerAction"
  > & {
    registerAction: (action: ControlUiActionV2) => ControlUiDisposer;
    registerPage: (page: ControlUiPageV2) => ControlUiDisposer;
    registerPanel: (panel: ControlUiPanelV2) => ControlUiDisposer;
    registerWidget: (widget: ControlUiWidgetV2) => ControlUiDisposer;
    registerReplacement: (replacement: ControlUiReplacementV2) => ControlUiDisposer;
    registerAccessory: (
      accessory: ControlUiAccessory | ControlUiSessionAccessory | ControlUiSessionBadgeAccessory,
    ) => ControlUiDisposer;
    registerTextReferenceProvider: (provider: ControlUiTextReferenceProvider) => ControlUiDisposer;
  };
};
export type ControlUiViewContextV2<T = Readonly<Record<string, string>>> = Omit<
  ControlUiViewContext<T>,
  "host"
> & { readonly host: ControlUiHostV2 };
export type ControlUiViewV2<T = Readonly<Record<string, string>>> = (
  container: HTMLElement,
  context: ControlUiViewContextV2<T>,
) => {
  update?: (context: ControlUiViewContextV2<T>) => void;
  focus?: () => void;
  dispose?: ControlUiDisposer;
} | void;

export type ControlUiPlugin = {
  id: string;
  apiVersion?: 1;
  activate: (host: ControlUiHost) => void | ControlUiDisposer | Promise<void | ControlUiDisposer>;
};

export function defineControlUiPlugin(plugin: ControlUiPlugin): ControlUiPlugin {
  return plugin;
}

export type ControlUiPluginV2 = {
  id: string;
  apiVersion: 2;
  activate: (host: ControlUiHostV2) => void | ControlUiDisposer | Promise<void | ControlUiDisposer>;
};
export function defineControlUiPluginV2(plugin: ControlUiPluginV2): ControlUiPluginV2 {
  return plugin;
}

export type { DoctorMemoryStatusPayload } from "../../packages/gateway-protocol/src/doctor-memory.js";
export type {
  ControlUiSettingsPlacement,
  ControlUiContributionSettingsPlacement,
  AnyControlUiSettingsPlacement,
  ControlUiSettingsComponentsV2,
  ControlUiSettingsSnapshot,
  ControlUiContributionSettingsSnapshot,
  ControlUiContributedSettingsView,
  ControlUiSettingsContextV2,
  ControlUiSettingsClient,
  ControlUiSettingsConfigMutation,
  ControlUiSettingsComponents,
  ControlUiSettingsContext,
  ControlUiSettingsView,
  ControlUiChannelSettingsSnapshot,
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsView,
} from "./control-ui-settings.js";

export type { ControlUiNativeHost } from "./control-ui-native.js";
export type {
  ControlUiPresentationHost,
  ControlUiLinkPreviewsProps,
  ControlUiIconProps,
  ControlUiToggleProps,
  ControlUiMarqueeOptions,
  ControlUiMenuControls,
  ControlUiMenuHandle,
  ControlUiMenuEntry,
  ControlUiMenuItemAttributes,
  ControlUiMenuProps,
  ControlUiActivityPillView,
} from "./control-ui-presentation.js";
