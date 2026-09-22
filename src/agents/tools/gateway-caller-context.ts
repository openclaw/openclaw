// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.types.js";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";
import type { WorkerSessionTurnClaim } from "../../gateway/worker-environments/placement-record.js";
import type { WorkerTurnExecutionIdentityCapability } from "../../gateway/worker-environments/placement-turn-claim-events.js";
import type { AgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  getAdmittedRunDelegatedAuthority,
  isAdmittedRunContextObservable,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
  type AdmittedRunContext,
  type OperationalRunInstanceRef,
} from "../admitted-run-context.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import type { EmbeddedRunToolAuthorityBinding } from "../embedded-agent-runner/run-state.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import type { AnyAgentTool } from "./common.js";

type GatewayToolCallerIdentity = {
  agentId: string;
  sessionKey: string;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  /** Prepared requesting-tool posture; absent authority never bypasses approvals. */
  fullPermission?: boolean;
  operationalRunInstance?: OperationalRunInstanceRef;
  embeddedRunToolAuthorityBinding?: EmbeddedRunToolAuthorityBinding;
  /** Exact run authority used to fence delegated system-agent approvals. */
  approvalAuthority?: AgentRunDelegatedAuthority;
  /** Original operator restriction, separate from this tool/turn's execution lifetime. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  approvalAuthorityCheck?: () => boolean | void;
  /** Exact host-resolved owner of this individual approval request. */
  approvalOwnerPluginId?: string;
  /** Host-owned tool/turn lifetimes; every same-run wrapper preserves earlier fences. */
  approvalSignals?: readonly AbortSignal[];
  /** Opaque already-signed identity used only by isolated worker transports. */
  signedAgentRuntimeIdentityToken?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  /** Synchronous host-owned fence for tool effects and decision receipts. */
  receiptAuthority?: () => boolean | void;
  /** Captured conversation policy for tools delegated through another tool's transport. */
  assertToolAllowed?: (toolName: string) => void;
  /** Exact Gateway-owned worker claim; never sourced from model or RPC arguments. */
  workerTurnClaim?: WorkerSessionTurnClaim;
  /** Closure-bound Gateway capability; revalidates both owners at child admission. */
  workerTurnExecutionIdentityCapability?: WorkerTurnExecutionIdentityCapability;
  /** Instance-bound routing only; delegated authority is revalidated separately. */
  gatewayContextResolver?: GatewayContextResolver;
  /** Host-signed capability for the scheduled run's existing self-management surface. */
  cronSelfManagementJobId?: string;
  cronToolsAllowCapture?: "final-executable-surface";
  /** Restrict-only policy enforced by exec on the captured creator surface. */
  cronExecToolTarget?: { host: "gateway"; ask?: "always" };
  /** One-shot Gateway-owned proof for a freshly resolved configured-MCP cap. */
  cronCreatorAuthorityGrant?: CronCreatorAuthorityGrant;
  /** Host-only native issuer retained by the current MCP grant; never serialized. */
  mintCronRequesterGrant?: (signal?: AbortSignal) => CronCreatorAuthorityGrant;
  cronManagementGrant?: CronCreatorAuthorityGrant;
  /** Cron permission can end while the admitted run retains its other tools. */
  cronAuthorityCheck?: () => boolean;
  // Trusted run context, carried separately from model-authored tool arguments.
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type GatewayToolCallerSource = {
  agentSessionKey?: string;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
};

const gatewayToolCallerStorage = new AsyncLocalStorage<GatewayToolCallerIdentity>();

// Observation follows the actual admitted object, never run/session metadata.
// This index is private, weak, and is not consulted by authorization or routing.
const admittedGatewayToolCallers = new WeakMap<GatewayToolCallerIdentity, AdmittedRunContext>();

const nativeGatewayObservationOwners = new WeakMap<
  AdmittedRunContext,
  GatewayContextResolver | null
>();

/** Native execution entry records its independent owner once; conflicting recapture stays unknown. */
export function bindAdmittedGatewayOwnerObservation(
  admitted: AdmittedRunContext,
  nativeOwner: GatewayContextResolver | undefined,
): void {
  if (!nativeGatewayObservationOwners.has(admitted)) {
    nativeGatewayObservationOwners.set(admitted, nativeOwner ?? null);
  } else if (nativeGatewayObservationOwners.get(admitted) !== nativeOwner) {
    nativeGatewayObservationOwners.set(admitted, null);
  }
}

export type GatewayToolCallerOwnerObservation = "match" | "mismatch" | "unobserved";

/** Observe the actual before-tool caller, using projections only as consistency checks. */
export function observeGatewayToolCallerOwner(context: {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  signal?: AbortSignal;
}): GatewayToolCallerOwnerObservation {
  const caller = gatewayToolCallerStorage.getStore();
  const admitted = caller && admittedGatewayToolCallers.get(caller);
  const nativeGatewayOwner = admitted && nativeGatewayObservationOwners.get(admitted);
  if (
    !caller ||
    !admitted ||
    !nativeGatewayOwner ||
    context.signal?.aborted ||
    caller.operationalRunInstance !== admitted.operationalRunInstance ||
    context.agentId !== caller.agentId ||
    context.sessionKey !== caller.sessionKey ||
    context.runId !== admitted.operationalRunInstance.runId ||
    !isAdmittedRunContextObservable(admitted)
  ) {
    return "unobserved";
  }
  const resolver = getGatewayContextResolver(admitted);
  const owner = resolver && getCanonicalGatewayContextResolver(resolver);
  const nativeOwner = getCanonicalGatewayContextResolver(nativeGatewayOwner);
  if (!owner || !nativeOwner) {
    return "unobserved";
  }
  return owner === nativeOwner ? "match" : "mismatch";
}

// Freeze the admitted instance: a later resolver result is a replacement,
// which retires this caller's routing authority instead of transferring it.
function bindGatewayToolContextResolver(
  resolveGatewayContext: GatewayContextResolver | undefined,
): GatewayContextResolver | undefined {
  if (!resolveGatewayContext) {
    return undefined;
  }
  let admittedContext: GatewayRequestContext | undefined;
  try {
    admittedContext = resolveGatewayContext();
  } catch {
    return () => undefined;
  }
  if (!admittedContext) {
    return () => undefined;
  }
  return () => {
    try {
      return resolveGatewayContext() === admittedContext ? admittedContext : undefined;
    } catch {
      return undefined;
    }
  };
}

type AdmittedGatewayToolCallerParams = {
  admittedRunContext: AdmittedRunContext;
  receiptAuthority?: () => boolean | void;
  cronAuthorityCheck?: () => boolean;
  mintCronRequesterGrant?: GatewayToolCallerIdentity["mintCronRequesterGrant"];
  approvalSignals?: readonly AbortSignal[];
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

function composeReceiptAuthority(
  ...predicates: Array<(() => boolean | void) | undefined>
): (() => boolean) | undefined {
  const checks = predicates.filter(
    (predicate, index): predicate is () => boolean | void =>
      predicate !== undefined && predicates.indexOf(predicate) === index,
  );
  return checks.length === 0
    ? undefined
    : () => {
        let active = true;
        for (const check of checks) {
          try {
            active = check() !== false && active;
          } catch {
            active = false;
          }
        }
        return active;
      };
}

/** Builds host-owned Gateway authority from the exact admitted execution. */
export function createAdmittedGatewayToolCallerIdentity(
  params: AdmittedGatewayToolCallerParams,
): GatewayToolCallerIdentity | undefined {
  const agentId = params.agentId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (!agentId || !sessionKey) {
    return undefined;
  }
  const delegatedAuthority = getAdmittedRunDelegatedAuthority(params.admittedRunContext);
  const operatorAuthority = readAdmittedRunOperatorAuthority(params.admittedRunContext);
  const identity: GatewayToolCallerIdentity = {
    agentId,
    sessionKey,
    operationalRunInstance: params.admittedRunContext.operationalRunInstance,
    ...(delegatedAuthority ? { approvalAuthority: delegatedAuthority } : {}),
    ...(operatorAuthority ? { operatorAuthority } : {}),
    ...(params.receiptAuthority ? { approvalAuthorityCheck: params.receiptAuthority } : {}),
    ...(params.cronAuthorityCheck ? { cronAuthorityCheck: params.cronAuthorityCheck } : {}),
    executionIdentityToken: params.admittedRunContext.executionIdentityToken,
    gatewayContextResolver: bindGatewayToolContextResolver(
      getGatewayContextResolver(params.admittedRunContext),
    ),
    receiptAuthority: composeReceiptAuthority(
      () =>
        delegatedAuthority !== undefined &&
        getAdmittedRunDelegatedAuthority(params.admittedRunContext) === delegatedAuthority,
      params.receiptAuthority,
    ),
    ...(params.approvalSignals?.length ? { approvalSignals: params.approvalSignals } : {}),
    ...(params.mintCronRequesterGrant
      ? { mintCronRequesterGrant: params.mintCronRequesterGrant }
      : {}),
    turnSourceChannel: params.turnSourceChannel,
    turnSourceLocal: params.turnSourceLocal,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  };
  admittedGatewayToolCallers.set(identity, params.admittedRunContext);
  return identity;
}

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

/** Capture the admitted run and worker owner, independently of optional audit collection. */
export function captureGatewayToolCallerAssertion(): ((method?: string) => void) | undefined {
  const caller = getGatewayToolCallerIdentity();
  if (!caller?.operationalRunInstance) {
    return undefined;
  }
  const isCurrent = caller.receiptAuthority;
  const signals = caller.approvalSignals ?? [];
  return (method) => {
    caller.operatorAuthority?.assertCurrent();
    if (!isCurrent || signals.some((signal) => signal.aborted) || isCurrent() === false) {
      throw new Error("agent tool caller authority is no longer active");
    }
    if (method?.startsWith("cron.") && caller.cronAuthorityCheck?.() === false) {
      throw new Error("Automation caller authority is no longer active.");
    }
  };
}

/** Process-owned work must not retain the turn that authorized its launch. */
export function withoutGatewayToolCallerIdentity<T>(run: () => T): T {
  return gatewayToolCallerStorage.exit(run);
}

export async function withGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim()) {
    return await run();
  }
  const inherited = gatewayToolCallerStorage.getStore();
  const suppliedRun = identity.operationalRunInstance;
  const inheritedRun = inherited?.operationalRunInstance;
  // Wrappers without a run inherit the admitted owner. A distinct admitted run
  // starts a new root; retaining the outer run would let child work outlive its owner.
  const inheritedOwner = !suppliedRun || inheritedRun === suppliedRun ? inherited : undefined;
  const operationalRunInstance =
    inheritedOwner?.operationalRunInstance ?? identity.operationalRunInstance;
  const embeddedRunToolAuthorityBinding =
    identity.embeddedRunToolAuthorityBinding ?? inheritedOwner?.embeddedRunToolAuthorityBinding;
  // Same-run wrappers can narrow a prepared posture, never erase a restriction.
  const fullPermission =
    inheritedOwner?.fullPermission === false || identity.fullPermission === false
      ? false
      : (inheritedOwner?.fullPermission ?? identity.fullPermission);
  const approvalAuthority = inheritedOwner?.approvalAuthority ?? identity.approvalAuthority;
  const operatorAuthority = inheritedOwner?.operatorAuthority ?? identity.operatorAuthority;
  const approvalAuthorityCheck =
    inheritedOwner?.approvalAuthorityCheck ?? identity.approvalAuthorityCheck;
  const signedAgentRuntimeIdentityToken =
    inheritedOwner?.signedAgentRuntimeIdentityToken ??
    identity.signedAgentRuntimeIdentityToken?.trim();
  const executionIdentityToken =
    inheritedOwner?.executionIdentityToken ?? identity.executionIdentityToken;
  const receiptAuthority = composeReceiptAuthority(
    inheritedOwner?.receiptAuthority,
    identity.receiptAuthority,
  );
  const toolPolicyAssertions = [
    ...new Set(
      [inheritedOwner?.assertToolAllowed, identity.assertToolAllowed].filter(
        (assertion): assertion is (toolName: string) => void => assertion !== undefined,
      ),
    ),
  ];
  const assertToolAllowed = toolPolicyAssertions.length
    ? (toolName: string) => {
        for (const assertion of toolPolicyAssertions) {
          assertion(toolName);
        }
      }
    : undefined;
  const approvalSignals = [
    ...new Set([...(inheritedOwner?.approvalSignals ?? []), ...(identity.approvalSignals ?? [])]),
  ];
  const workerTurnClaim = inheritedOwner?.workerTurnClaim ?? identity.workerTurnClaim;
  const workerTurnExecutionIdentityCapability =
    inheritedOwner?.workerTurnExecutionIdentityCapability ??
    identity.workerTurnExecutionIdentityCapability;
  const gatewayContextResolver =
    inheritedOwner?.gatewayContextResolver ??
    bindGatewayToolContextResolver(identity.gatewayContextResolver);
  const cronSelfManagementJobId =
    identity.cronSelfManagementJobId?.trim() ?? inheritedOwner?.cronSelfManagementJobId;
  const cronToolsAllowCapture =
    identity.cronToolsAllowCapture ?? inheritedOwner?.cronToolsAllowCapture;
  const cronExecToolTarget = identity.cronExecToolTarget ?? inheritedOwner?.cronExecToolTarget;
  const cronCreatorAuthorityGrant =
    identity.cronCreatorAuthorityGrant ?? inheritedOwner?.cronCreatorAuthorityGrant;
  const mintCronRequesterGrant =
    inheritedOwner?.mintCronRequesterGrant ?? identity.mintCronRequesterGrant;
  const cronManagementGrant = identity.cronManagementGrant ?? inheritedOwner?.cronManagementGrant;
  const cronAuthorityCheck = composeReceiptAuthority(
    inheritedOwner?.cronAuthorityCheck,
    identity.cronAuthorityCheck,
  );
  const turnSourceChannel = inheritedOwner?.turnSourceChannel ?? identity.turnSourceChannel?.trim();
  const turnSourceLocal = inheritedOwner?.turnSourceLocal ?? identity.turnSourceLocal;
  const turnSourceTo = inheritedOwner?.turnSourceTo ?? identity.turnSourceTo?.trim();
  const turnSourceAccountId =
    inheritedOwner?.turnSourceAccountId ?? identity.turnSourceAccountId?.trim();
  const turnSourceThreadId = inheritedOwner?.turnSourceThreadId ?? identity.turnSourceThreadId;
  const gatewayUiCommandTarget =
    inheritedOwner?.gatewayUiCommandTarget ?? identity.gatewayUiCommandTarget;
  const caller: GatewayToolCallerIdentity = {
    agentId: inheritedOwner?.agentId ?? identity.agentId.trim(),
    sessionKey: inheritedOwner?.sessionKey ?? identity.sessionKey.trim(),
    ...(fullPermission !== undefined ? { fullPermission } : {}),
    ...(operationalRunInstance ? { operationalRunInstance } : {}),
    ...(embeddedRunToolAuthorityBinding ? { embeddedRunToolAuthorityBinding } : {}),
    ...(approvalAuthority ? { approvalAuthority } : {}),
    ...(operatorAuthority ? { operatorAuthority } : {}),
    ...(approvalAuthorityCheck ? { approvalAuthorityCheck } : {}),
    ...(identity.approvalOwnerPluginId?.trim()
      ? { approvalOwnerPluginId: identity.approvalOwnerPluginId.trim() }
      : inheritedOwner?.approvalOwnerPluginId
        ? { approvalOwnerPluginId: inheritedOwner.approvalOwnerPluginId }
        : {}),
    ...(signedAgentRuntimeIdentityToken ? { signedAgentRuntimeIdentityToken } : {}),
    ...(cronSelfManagementJobId ? { cronSelfManagementJobId } : {}),
    ...(cronToolsAllowCapture ? { cronToolsAllowCapture } : {}),
    ...(cronExecToolTarget ? { cronExecToolTarget } : {}),
    ...(cronCreatorAuthorityGrant ? { cronCreatorAuthorityGrant } : {}),
    ...(mintCronRequesterGrant ? { mintCronRequesterGrant } : {}),
    ...(cronManagementGrant ? { cronManagementGrant } : {}),
    ...(cronAuthorityCheck ? { cronAuthorityCheck } : {}),
    ...(executionIdentityToken ? { executionIdentityToken } : {}),
    ...(receiptAuthority ? { receiptAuthority } : {}),
    ...(assertToolAllowed ? { assertToolAllowed } : {}),
    ...(approvalSignals.length ? { approvalSignals } : {}),
    ...(workerTurnClaim ? { workerTurnClaim } : {}),
    ...(workerTurnExecutionIdentityCapability ? { workerTurnExecutionIdentityCapability } : {}),
    ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
    ...(gatewayUiCommandTarget ? { gatewayUiCommandTarget } : {}),
    ...(turnSourceChannel ? { turnSourceChannel } : {}),
    ...(turnSourceLocal === true ? { turnSourceLocal: true } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
    ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
  };
  const admitted = admittedGatewayToolCallers.get(inheritedOwner ?? identity);
  if (admitted) {
    admittedGatewayToolCallers.set(caller, admitted);
  }
  return await gatewayToolCallerStorage.run(caller, run);
}

/** Narrows one host-owned approval call to the exact registered policy/harness owner. */
export async function withGatewayToolApprovalOwner<T>(
  pluginId: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const identity = gatewayToolCallerStorage.getStore();
  const approvalOwnerPluginId = pluginId?.trim();
  if (!identity || !approvalOwnerPluginId) {
    return await run();
  }
  return await withGatewayToolCallerIdentity({ ...identity, approvalOwnerPluginId }, run);
}

export function wrapToolWithGatewayCallerIdentity(
  tool: AnyAgentTool,
  identity: GatewayToolCallerIdentity | undefined,
): AnyAgentTool {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim() || !tool.execute) {
    return tool;
  }
  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (...args) =>
      await withGatewayToolCallerIdentity(identity, async () => await tool.execute?.(...args)),
  };
  copyAgentToolMetadata(tool, wrapped);
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(wrapped, async (params) => {
      const prepared = await withGatewayToolCallerIdentity(identity, () => sourcePreparer(params));
      return prepared.kind === "ready"
        ? {
            ...prepared,
            execute: (start) =>
              withGatewayToolCallerIdentity(identity, () => prepared.execute(start)),
          }
        : prepared;
    });
  }
  return wrapped;
}

export function createGatewayToolCallerWrapper(
  agentId: string | undefined,
  source: GatewayToolCallerSource | undefined,
): (tool: AnyAgentTool) => AnyAgentTool {
  const identity =
    agentId && source?.agentSessionKey?.trim()
      ? {
          agentId,
          sessionKey: source.agentSessionKey.trim(),
          gatewayUiCommandTarget: source.gatewayUiCommandTarget,
          turnSourceChannel: source.agentChannel,
          turnSourceTo: source.currentMessagingTarget ?? source.currentChannelId ?? source.agentTo,
          turnSourceAccountId: source.agentAccountId,
          turnSourceThreadId: source.currentThreadTs ?? source.agentThreadId,
        }
      : undefined;
  return (tool) => wrapToolWithGatewayCallerIdentity(tool, identity);
}
