import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { ReplyExpectation } from "../agents/reply-completion.js";
import type { SubagentCompletionToolHandoffRegistration } from "../agents/subagents/announce/subagent-announce-handoff.js";
import type { PluginSubagentRequesterContext } from "../plugins/runtime/subagent-requester-context.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import type { SessionControllerInput } from "../sessions/session-controller.contracts.js";
import type {
  AgentTurnStartOwner,
  RequesterSettleWakeReplay,
} from "./agent-turn/internal-facade.types.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type {
  GatewayAgentRunTaskOwner,
  GatewayContextResolver,
  GatewayNodeInvokeStream,
  GatewayRequestContext,
  GatewayRequestOptions,
  TrustedAgentToolCaller,
} from "./server-methods/types.js";
import type { TrustedSessionCreation } from "./session-creation-provenance.js";

export type PrepareInProcessAgentExecutionOptions = {
  agentId: string;
  pluginRuntimeOwnerId: string;
  resolveGatewayContext?: GatewayContextResolver;
};

export type DispatchGatewayMethodInProcessOptions = {
  /** Exact host-owned source reference for an in-process agent continuation. */
  controllerInput?: SessionControllerInput;
  privateCompletion?: true;
  /** Trusted input-owner policy; not accepted from the wire request. */
  replyExpectation?: ReplyExpectation;
  settleWakeReplay?: RequesterSettleWakeReplay;
  allowSyntheticModelOverride?: boolean;
  agentToolCaller?: TrustedAgentToolCaller;
  agentRunTracking?: GatewayAgentRunTaskOwner;
  cancelOnDeadline?: boolean;
  disableSyntheticClient?: boolean;
  expectFinal?: boolean;
  forceSyntheticClient?: boolean;
  /** Host-only, request-scoped bridge for a plugin approval prompt. */
  allowHostPluginApprovalRequest?: boolean;
  nodeInvokeStream?: GatewayNodeInvokeStream;
  nodeInvokeApprovalSessionKey?: string;
  onAccepted?: (payload: unknown) => void;
  onStartOwner?: (owner: AgentTurnStartOwner) => void;
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
  /** Gateway instance lifetime; accepted execution checks its own retained principal. */
  assertGatewayCurrent: () => void;
  /** Original source grant and Gateway lifetime, rechecked during turn admission. */
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
