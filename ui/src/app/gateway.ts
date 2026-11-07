import type {
  ModelCatalogTarget,
  UserProfile,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewaySuspension } from "../../../packages/gateway-protocol/src/schema/gateway-suspend.js";
import type { PluginsUiDescriptorsResult } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { ControlUiBootstrapProfileHint } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { SessionCostUsagePublication } from "../../../src/shared/usage-types.js";
import type { EventLogEntry } from "../api/event-log.ts";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayEventListener,
  GatewayHelloOk,
} from "../api/gateway.ts";
import type { PresenceEntry } from "../api/types.ts";
import type { AuthenticatedUser } from "./user-profile.ts";

export type ApplicationGatewayPhase =
  | "stopped"
  | "connecting"
  | "starting"
  | "connected"
  | "reconnecting"
  | "reload-required"
  | "offline";

export type ApplicationGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  /** The live transport/admission fact; retained hello metadata does not authorize dispatch. */
  phase: ApplicationGatewayPhase;
  offlineStable: boolean;
  /** Memory-only desired-state changes waiting for the same admitted identity. */
  deferredIntentCount?: number;
  deferredIntentDraining?: boolean;
  restartPending?: boolean;
  suspensionPhase?: GatewaySuspension["phase"];
  /**
   * Last accepted handshake for the current client identity, retained while reconnecting.
   * A new hello replaces it; plugin capability refreshes preserve its object identity.
   * Live dispatch eligibility comes from phase, not hello presence.
   */
  hello: GatewayHelloOk | null;
  pluginCapabilities?: PluginsUiDescriptorsResult | null;
  usagePublications?: Readonly<
    Record<string, Readonly<Omit<SessionCostUsagePublication, "agentId"> & { committedAt: number }>>
  >;
  canvasPluginSurfaceUrl: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  lastError: string | null;
  lastErrorCode: string | null;
  reconnectAt?: number;
  lastErrorAuthReason?: string | null;
  /** This connection owns identity: undefined is unresolved; null is resolved profileless. */
  selfUser?: AuthenticatedUser | null;
};

export type ApplicationGatewayConnection = {
  gatewayUrl: string;
  token: string;
  bootstrapToken: string;
  bootstrapProfile?: ControlUiBootstrapProfileHint;
  password: string;
};

export type ApplicationGatewayConnectOptions = Partial<ApplicationGatewayConnection> & {
  sessionKey?: string;
};

export type ApplicationGatewayOptions = {
  persistDefaultConnectionSettings?: boolean;
  /** Shellless documents do not own the application’s shared warm admission. */
  ownsWarmBoot?: boolean;
  resourceBasePath?: string;
  bootstrapProfile?: ControlUiBootstrapProfileHint;
  getModelCatalogTarget?: (gatewayUrl: string) => ModelCatalogTarget | undefined;
  clientOptions?: Pick<
    GatewayBrowserClientOptions,
    | "clientName"
    | "mode"
    | "platform"
    | "deviceFamily"
    | "instanceId"
    | "scopes"
    | "nativeConnectAuth"
  >;
};

export type ApplicationGatewayDeferredIntent = {
  key: string;
  /** Related intents that a terminal desired state may supersede. */
  group?: string;
  discardGroup?: boolean;
  preservePosition?: boolean;
  run: (client: GatewayBrowserClient) => Promise<void>;
  discard?: () => void;
};

export type ApplicationGateway = {
  readonly snapshot: ApplicationGatewaySnapshot;
  /** Full normalized roster; unresolved until this connection's first presence reset. */
  readonly readPresence?: () => readonly PresenceEntry[] | undefined;
  readonly connection: ApplicationGatewayConnection;
  readonly connectionRevision: number;
  /** Raw history is captured only while subscribeEventLog has consumers. */
  readonly eventLog: readonly EventLogEntry[];
  /** Advances when the connection or authentication context retires diagnostic history. */
  readonly eventLogRevision: number;
  connect: (connection?: ApplicationGatewayConnectOptions) => void;
  defer: (intent: ApplicationGatewayDeferredIntent) => boolean;
  setSessionKey: (sessionKey: string) => void;
  start: () => void;
  stop: () => void;
  subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
  subscribeEventLog: (listener: (events: readonly EventLogEntry[]) => void) => () => void;
  subscribeEvents: (
    listener: GatewayEventListener,
    options?: { includeMessageBodies?: boolean },
  ) => () => void;
  loadSelfProfile: () => Promise<UserProfile | null>;
  updateSelfUser?: (patch: Partial<Omit<AuthenticatedUser, "id">>) => void;
  /** True when this browser holds a stored operator device token for the current gateway. */
  hasStoredDeviceToken?: () => boolean;
  /**
   * Forget the operator device token this browser stores for the current
   * gateway, then reconnect without it. Token-only reset: the browser device
   * identity and other gateways' tokens survive. Returns false when no
   * credential was stored.
   */
  forgetDeviceToken?: () => boolean;
};
