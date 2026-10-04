/** Browser-only contract for trusted native Control UI plugins. No host implementation imports. */
import type {
  AgentSummary,
  BoardGetParams,
  SessionRow,
  SessionsListParams,
} from "@openclaw/gateway-protocol";
import type { ControlUiComponents } from "./control-ui-components.js";
export { createSessionHeaderLink } from "./control-ui-session-link.js";
export type {
  ControlUiAgentPickerProps,
  ControlUiComponentHandle,
  ControlUiComponents,
  ControlUiDashboardProps,
  ControlUiDialogProps,
} from "./control-ui-components.js";
export type ControlUiDisposer = () => void;

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
export type ControlUiPanelTarget = {
  id: string;
  params?: Readonly<Record<string, string>>;
};
export type ControlUiPanelProps = BoardGetParams & {
  /** Plugin resource scope; independent of the conversation's sessionKey and agentId. */
  params?: Readonly<Record<string, string>>;
};
export type ControlUiLinkRoute = {
  id: string;
  pageId: string;
  from: "chat";
  /** Pure synchronous mapping. Return null to retain ordinary page navigation. */
  resolve: (page: ControlUiPageTarget) => ControlUiPanelTarget | null;
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
};

export type ControlUiPanel = {
  id: string;
  label: string;
  mount: ControlUiView<ControlUiPanelProps>;
};

export type ControlUiAction = {
  id: string;
  label: string;
  placement: "composer" | "header" | "session";
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

export type ControlUiAccessory = {
  id: string;
  placement: "session-header";
  mount: ControlUiView<BoardGetParams & { session?: ControlUiSession }>;
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
    create: (params?: { agentId?: string; label?: string }) => Promise<string | null>;
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
    /** One route per owned registered page/source. Duplicates throw; disposal releases it. */
    registerLinkRoute: (route: ControlUiLinkRoute) => ControlUiDisposer;
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
    registerPanel: (panel: ControlUiPanel) => ControlUiDisposer;
    /** Open an owned registered panel beside the supplied or currently selected session. */
    openPanel: {
      (id: string, session?: BoardGetParams): void;
      /** True accepts the destination, not resource loading or authorization. */
      (target: ControlUiPanelTarget, session?: BoardGetParams): boolean;
    };
    registerAction: (action: ControlUiAction) => ControlUiDisposer;
    registerAccessory: (accessory: ControlUiAccessory) => ControlUiDisposer;
    registerWidget: (widget: ControlUiWidget) => ControlUiDisposer;
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
