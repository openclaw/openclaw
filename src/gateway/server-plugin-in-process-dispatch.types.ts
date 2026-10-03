import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { SubagentCompletionToolHandoffRegistration } from "../agents/subagents/announce/subagent-announce-handoff.js";
import type { PluginSubagentRequesterContext } from "../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { RequesterSettleWakeReplay } from "./agent-turn/internal-facade.types.js";
import type { TrustedSessionCreation } from "./server-methods/session-creation-provenance.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type {
  GatewayAgentRunTaskOwner,
  GatewayContextResolver,
  GatewayNodeInvokeStream,
  GatewayRequestContext,
  GatewayRequestOptions,
  TrustedAgentToolCaller,
} from "./server-methods/types.js";

export type PrepareInProcessAgentExecutionOptions = {
  agentId: string;
  pluginRuntimeOwnerId: string;
  resolveGatewayContext?: GatewayContextResolver;
};

export type DispatchGatewayMethodInProcessOptions = {
  privateCompletion?: true;
  settleWakeReplay?: RequesterSettleWakeReplay;
  allowSyntheticModelOverride?: boolean;
  agentToolCaller?: TrustedAgentToolCaller;
  agentRunTracking?: GatewayAgentRunTaskOwner;
  cancelOnDeadline?: boolean;
  disableSyntheticClient?: boolean;
  expectFinal?: boolean;
  forceSyntheticClient?: boolean;
  nodeInvokeStream?: GatewayNodeInvokeStream;
  nodeInvokeApprovalSessionKey?: string;
  onAccepted?: (payload: unknown) => void;
  onExecution?: (execution: Promise<void>) => void;
  onExecutionStarted?: () => void;
  onSignalAbort?: () => Promise<void> | void;
  operatorRoleActor?: GatewayOperatorRoleActor;
  pluginRuntimeOwnerId?: string;
  pluginSubagentRequester?: PluginSubagentRequesterContext;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  pluginSubagentToolsAllow?: string[];
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  sessionCreation?: TrustedSessionCreation;
  requireScopedClient?: boolean;
  syntheticScopes?: string[];
  /** Built-in adapters distinguish method minima from explicit or retained scope ceilings. */
  syntheticScopeMode?: "minimum" | "exact";
  timeoutMs?: number;
  signal?: AbortSignal;
  hasCurrentClientAuthority?: GatewayRequestOptions["hasCurrentClientAuthority"];
  resolveGatewayContext?: GatewayContextResolver;
  prepareDispatchCurrent?: () => Promise<void>;
  sessionMutationCommitGuard?: () => void;
};

export type ResolvedInProcessGatewayDispatch = {
  /** Source custody after an accepted transfer, independent of its authorizing invocation. */
  assertSourceCurrent: () => void;
  assertContextCurrent: () => void;
  assertCreatedInputSourceCurrent?: () => void;
  assertInvocationCurrent: () => void;
  client: NonNullable<GatewayRequestOptions["client"]>;
  context: GatewayRequestContext;
  delegatedToolPolicyHandoffId?: string;
  isWebchatConnect: NonNullable<GatewayRequestOptions["isWebchatConnect"]>;
  operatorSourceClient: NonNullable<GatewayRequestOptions["client"]>;
  hasCurrentClientAuthority?: GatewayRequestOptions["hasCurrentClientAuthority"];
};

export type OperatorToolGatewayAuthority = {
  authenticatedUserProfile?: NonNullable<
    NonNullable<GatewayRequestOptions["client"]>["authenticatedUserProfile"]
  >;
  scopes: readonly string[];
  operatorRoleActor?: GatewayOperatorRoleActor;
  operatorRunAuthority?: AdmittedRunOperatorAuthority;
  signal: AbortSignal;
  assertCurrent?: () => void;
  /** Pure input policy; applies at effects, never settled results or cleanup. */
  assertInputCommitAllowed?: () => void;
};
