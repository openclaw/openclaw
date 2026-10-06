// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { ReplyTurnParticipants } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import type { SessionEntriesCurrentCheck } from "../../config/sessions/session-entry-current.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.types.js";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";
import type { WorkerSessionTurnClaim } from "../../gateway/worker-environments/placement-record.js";
import type { WorkerTurnExecutionIdentityCapability } from "../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  captureAdmittedRunActiveAssertion,
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
  type AdmittedRunContext,
  type OperationalRunInstanceRef,
} from "../admitted-run-context.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import {
  captureActiveEmbeddedRunPersonalToolParticipants,
  type EmbeddedRunToolAuthorityBinding,
} from "../embedded-agent-runner/run-state.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { readToolStringParam, type AnyAgentTool } from "./common.js";
import type { GatewayToolCallerReceiptAdmission } from "./gateway-caller-receipt.types.js";

type ReceiptAuthority = (() => boolean | void) &
  Pick<SessionSourceAssertion, "prepareSessionSource" | "nativeSource">;

type GatewayToolCallerIdentity = {
  personalToolParticipants?: ReplyTurnParticipants;
  personalToolUser?: string;
  personalToolIdentityScoped?: true;
  personalToolSelection?: GatewayToolOperatorSelection;
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
  receiptAuthority?: ReceiptAuthority;
  receiptAdmissions?: readonly GatewayToolCallerReceiptAdmission[];
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

const receiptAdmissionStorage = new AsyncLocalStorage<
  ReadonlyMap<GatewayToolCallerReceiptAdmission, () => boolean>
>();

export function evaluateGatewayToolCallerReceiptAdmission(
  admission: GatewayToolCallerReceiptAdmission,
  otherwise: () => boolean,
): boolean {
  const prepared = receiptAdmissionStorage.getStore()?.get(admission);
  return prepared ? prepared() : otherwise();
}

export type GatewayToolOperatorSelection = Readonly<{
  /** Raw host-issued source; custody transfers must not retain the turn-bound assertion. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertCurrent: () => void;
}>;

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
  const resolveAdmittedContext = () => {
    try {
      return resolveGatewayContext() === admittedContext ? admittedContext : undefined;
    } catch {
      return undefined;
    }
  };
  bindGatewayContextResolver(resolveAdmittedContext, admittedContext.resolveGatewayContext);
  return resolveAdmittedContext;
}

type AdmittedGatewayToolCallerParams = {
  admittedRunContext: AdmittedRunContext;
  receiptAuthority?: ReceiptAuthority;
  receiptAdmission?: GatewayToolCallerReceiptAdmission;
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
  ...predicates: Array<ReceiptAuthority | undefined>
): ((() => boolean) & ReceiptAuthority) | undefined {
  const checks = predicates.filter(
    (predicate, index): predicate is ReceiptAuthority =>
      predicate !== undefined && predicates.indexOf(predicate) === index,
  );
  return checks.length === 0
    ? undefined
    : Object.assign(
        () => {
          let active = true;
          for (const check of checks) {
            try {
              active = check() !== false && active;
            } catch {
              active = false;
            }
          }
          return active;
        },
        composeSessionSourceAssertion(
          checks.map((check) => captureGatewayToolReceiptAssertion(check)),
        ),
      );
}

/** Preserve boolean refusal across the receipt owner's prepared assertion. */
export function captureGatewayToolReceiptAssertion(
  receipt: ReceiptAuthority,
  message = "agent tool caller authority is no longer active",
): SessionSourceAssertion {
  const assertAllowed = (result: boolean | void) => {
    if (result === false) {
      throw new Error(message);
    }
  };
  const prepare = receipt.prepareSessionSource?.bind(receipt);
  return Object.assign(() => assertAllowed(receipt()), {
    nativeSource: receipt.nativeSource,
    ...(prepare
      ? {
          async prepareSessionSource() {
            const prepared = await prepare();
            const release = prepared.release?.bind(prepared);
            return {
              nativeSource: prepared.nativeSource,
              checks: prepared.checks,
              assertCurrent: () => assertAllowed(prepared.assertCurrent()),
              ...(release ? { release } : {}),
            };
          },
        }
      : {}),
  });
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
  return {
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
      (delegatedAuthority &&
        captureAdmittedRunActiveAssertion(params.admittedRunContext, delegatedAuthority)) ??
        (() => false),
      params.receiptAuthority,
    ),
    ...(params.receiptAdmission ? { receiptAdmissions: [params.receiptAdmission] } : {}),
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
}

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

/** Selection is model input; only the turn's host-owned participants grant a target. */
export async function withGatewayPersonalToolUser<T>(
  user: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    if (user !== undefined) {
      throw new Error("Selecting user requires an active personal-tool turn.");
    }
    return await run();
  }
  return await gatewayToolCallerStorage.run(
    {
      ...caller,
      personalToolUser: user,
      personalToolIdentityScoped: true,
      personalToolSelection: undefined,
    },
    run,
  );
}

/** One prepared identity per tool call; execution, approvals and receipts stay turn-owned. */
export function resolveGatewayToolOperatorSelection(): GatewayToolOperatorSelection {
  const caller = getGatewayToolCallerIdentity();
  if (caller?.personalToolSelection) {
    return caller.personalToolSelection;
  }
  const participant = caller?.personalToolIdentityScoped
    ? resolveGatewayPersonalToolParticipant()
    : undefined;
  const operatorAuthority =
    participant && participant.profileId !== caller?.operatorAuthority?.profileId
      ? participant.operatorAuthority
      : caller?.operatorAuthority;
  const selection = Object.freeze({
    operatorAuthority,
    assertCurrent: composeSessionSourceAssertion([
      participant?.assertCurrent,
      operatorAuthority?.assertCurrent,
    ]),
  });
  if (caller?.personalToolIdentityScoped) {
    caller.personalToolSelection = selection;
  }
  return selection;
}

/** The accepting collector already holds this source independently of the spawning turn. */
export function withGatewayToolOperatorContinuation<T>(
  operatorAuthority: AdmittedRunOperatorAuthority | undefined,
  run: () => T,
): T {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    return run();
  }
  operatorAuthority?.assertCurrent();
  return gatewayToolCallerStorage.run(
    {
      ...caller,
      personalToolParticipants: undefined,
      personalToolUser: undefined,
      personalToolIdentityScoped: true,
      personalToolSelection: Object.freeze({
        operatorAuthority,
        assertCurrent: composeSessionSourceAssertion([operatorAuthority?.assertCurrent]),
      }),
    },
    run,
  );
}

export function resolveGatewayPersonalToolParticipant(
  runtimeIdentity?: AgentRuntimeIdentity,
  options?: {
    requireSingleParticipant?: boolean;
    allowTurnOwner?: () => boolean;
    allowMissingRegistry?: boolean;
  },
) {
  const caller = getGatewayToolCallerIdentity();
  if (caller?.personalToolParticipants) {
    return caller.personalToolParticipants.resolve(
      options?.requireSingleParticipant ? undefined : caller.personalToolUser,
      options,
    );
  }
  if (caller?.personalToolUser !== undefined) {
    throw new Error("Selecting user requires an active personal-tool turn.");
  }
  if (runtimeIdentity) {
    const registered = captureActiveEmbeddedRunPersonalToolParticipants(runtimeIdentity, options);
    if (!registered) {
      return undefined;
    }
    const participant = registered.participants?.resolve(undefined, options);
    return (
      participant && {
        ...participant,
        assertCurrent: composeSessionSourceAssertion([
          registered.assertCurrent,
          participant.assertCurrent,
        ]),
      }
    );
  }
  return undefined;
}

/** Capture the admitted run and worker owner, independently of optional audit collection. */
export function captureGatewayToolCallerAssertion(
  boundMethod?: string,
): ((method?: string) => void) | undefined {
  const caller = getGatewayToolCallerIdentity();
  if (!caller?.operationalRunInstance) {
    return undefined;
  }
  const isCurrent = caller.receiptAuthority;
  const signals = caller.approvalSignals ?? [];
  const selection = caller.personalToolIdentityScoped
    ? resolveGatewayToolOperatorSelection()
    : undefined;
  const assertMethod = (method?: string) => {
    if (method?.startsWith("cron.") && caller.cronAuthorityCheck?.() === false) {
      throw new Error("Automation caller authority is no longer active.");
    }
  };
  const assertCurrent = composeSessionSourceAssertion(
    [
      selection?.assertCurrent,
      caller.operatorAuthority?.assertCurrent,
      composeSessionSourceAssertion(
        isCurrent ? [captureGatewayToolReceiptAssertion(isCurrent)] : [],
        (assertReceipt) => {
          try {
            if (!isCurrent || signals.some((signal) => signal.aborted)) {
              throw new Error("agent tool caller authority is no longer active");
            }
            assertReceipt();
          } catch {
            throw new Error("agent tool caller authority is no longer active");
          }
        },
      ),
    ],
    (assertSources) => {
      assertSources();
      assertMethod(boundMethod);
    },
  );
  return Object.assign((method = boundMethod) => {
    assertCurrent();
    if (method !== boundMethod) {
      assertMethod(method);
    }
  }, assertCurrent);
}

/** Watch admission preserves opaque lifecycle assertions while moving registered row predicates. */
export async function prepareGatewayToolCallerAssertion(): Promise<{
  assertCurrent?: () => void;
  sessionEntriesCurrent?: SessionEntriesCurrentCheck;
  release(): void;
}> {
  const caller = getGatewayToolCallerIdentity();
  const assertion = captureGatewayToolCallerAssertion();
  const admissions = [...new Set(caller?.receiptAdmissions ?? [])];
  const prepared = await Promise.all(admissions.map((admission) => admission.prepare()));
  const predicates = new Map(
    admissions.map((admission, index) => [admission, () => prepared[index]!.isCurrent()] as const),
  );
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("agent tool caller admission is no longer active");
    }
    receiptAdmissionStorage.run(predicates, () => assertion?.());
  };
  assertCurrent();
  return {
    assertCurrent,
    ...(prepared.length
      ? {
          sessionEntriesCurrent: {
            sources: prepared.flatMap((entry) => entry.current.sources),
            assertCurrent(entries) {
              let offset = 0;
              for (const entry of prepared) {
                entry.current.assertCurrent(
                  entries.slice(offset, offset + entry.current.sources.length),
                );
                offset += entry.current.sources.length;
              }
              assertCurrent();
            },
          },
        }
      : {}),
    release() {
      active = false;
      predicates.clear();
    },
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
  let approvalAuthority = inheritedOwner?.approvalAuthority ?? identity.approvalAuthority;
  if (
    inheritedOwner?.approvalAuthority &&
    identity.approvalAuthority &&
    inheritedOwner.approvalAuthority !== identity.approvalAuthority
  ) {
    if (
      validateAgentRunDelegatedAuthority(
        identity.approvalAuthority,
        inheritedOwner.approvalAuthority,
      )
    ) {
      approvalAuthority = identity.approvalAuthority;
    } else if (
      !validateAgentRunDelegatedAuthority(
        inheritedOwner.approvalAuthority,
        identity.approvalAuthority,
      )
    ) {
      throw new Error("agent tool caller approval scopes do not retain the same source");
    }
  }
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
  const receiptAdmissions = [
    ...new Set([
      ...(inheritedOwner?.receiptAdmissions ?? []),
      ...(identity.receiptAdmissions ?? []),
    ]),
  ];
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
  return await gatewayToolCallerStorage.run(
    {
      agentId: inheritedOwner?.agentId ?? identity.agentId.trim(),
      sessionKey: inheritedOwner?.sessionKey ?? identity.sessionKey.trim(),
      personalToolParticipants:
        inheritedOwner?.personalToolParticipants ?? identity.personalToolParticipants,
      personalToolUser: inheritedOwner?.personalToolUser ?? identity.personalToolUser,
      personalToolIdentityScoped:
        inheritedOwner?.personalToolIdentityScoped ?? identity.personalToolIdentityScoped,
      personalToolSelection:
        inheritedOwner?.personalToolSelection ?? identity.personalToolSelection,
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
      ...(receiptAdmissions.length ? { receiptAdmissions } : {}),
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
    },
    run,
  );
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
  copyAgentToolMetadata(tool, wrapped, (source) =>
    wrapToolWithGatewayCallerIdentity(source, identity),
  );
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

/** Opt an identity-scoped tool into participant selection, including unnamed calls. */
export function wrapGatewayPersonalToolExecution(
  execute: AnyAgentTool["execute"],
): AnyAgentTool["execute"] {
  return async (...args) =>
    await withGatewayPersonalToolUser(
      readToolStringParam(asNonArrayRecord(args[1]) ?? {}, "user"),
      async () => {
        const caller = getGatewayToolCallerIdentity();
        const selection = resolveGatewayToolOperatorSelection();
        selection.assertCurrent();
        const result = await execute(...args);
        // Existing no-registry tools own their handled failure and cleanup receipts.
        if (caller?.personalToolParticipants) {
          selection.assertCurrent();
        }
        return result;
      },
    );
}
