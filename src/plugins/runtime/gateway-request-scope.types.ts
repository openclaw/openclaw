import type {
  GatewayContextResolver,
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import type { PluginOrigin } from "../plugin-origin.types.js";
import type { DeclaredProviderOwnerIndex } from "../provider-owner-index.js";
import type { PluginRegistry } from "../registry-types.js";
import type { OpenClawPluginNodeWorkspace } from "../types.node-host.js";

/** Facts and guards from one admitted plugin handler invocation. */
export type GatewayRequestAuthorityV1 = Readonly<{
  scopes: readonly string[];
  clientIp?: string;
  /** Display attribution may identify the shared Gateway owner. */
  attributionProfileId?: string;
  /** Present only for an individually authenticated operator. */
  personProfileId?: string;
  /** Policy explicitly required by the admitted role and matched by its original grant. */
  requiredGrantPluginId?: string;
  assertCurrent(requiredGrantPluginId?: string): void;
  revalidate(requiredGrantPluginId?: string): Promise<void>;
}>;

export type PluginRuntimeGatewayRequestScope = {
  readRequestAuthority?: (
    client: PluginRuntimeGatewayRequestScope["client"],
  ) => GatewayRequestAuthorityV1 | undefined;
  parentHttpRequestAuthority?: () => GatewayRequestAuthorityV1 | undefined;
  /** Request-owned reader headroom expires when the interactive handler settles. */
  canUseInteractiveStateReadCapacity?: () => boolean;
  /** Exact registration and Gateway owner retained across awaited system operations. */
  assertSystemOwnerCurrent?: () => void;
  /** Recheck the admitted HTTP device or cookie grant before effects/disclosure; rejection sends HTTP 401 and throws. */
  revalidate?: () => Promise<void>;
  /** Contextual ingress owns asynchronous stream work through its actual settlement. */
  trackWork?: <T>(work: Promise<T>) => Promise<T>;
  /** Exact placement owner captured before the local harness begins. */
  assertNodeExecutionCurrent?: (request: {
    runId: string;
    agentId: string;
    nodeId: string;
    workspace: OpenClawPluginNodeWorkspace;
  }) => void;
  /** In-process admitted owner only; never projected into RPC parameters. */
  invokeWithSessionNodeAuthority?: <T>(
    request: {
      pluginId: string;
      command: string;
      source: "session-full" | "human-approved";
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    },
    invoke: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T | undefined>;
  /** Closure-bound admitted owner used to validate placement grant bindings. */
  nodePlacementGrantAuthority?: {
    agentId: string;
    sessionKey: string;
    runId: string;
    assertCurrent: (request: {
      pluginId: string;
      command: string;
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    }) => void;
  };
  context?: GatewayRequestContext;
  resolveGatewayContext?: GatewayContextResolver;
  client?: GatewayRequestOptions["client"];
  /** Original request-owned cancellation and live transport authority, never wire data. */
  signal?: GatewayRequestOptions["signal"];
  hasCurrentClientAuthority?: GatewayRequestOptions["hasCurrentClientAuthority"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  gatewayMethodDispatchAllowed?: boolean;
  pluginRegistry?: PluginRegistry;
  declaredProviderOwners?: DeclaredProviderOwnerIndex;
};
