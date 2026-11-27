import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  inheritSessionEventToolPolicy,
  narrowSessionEventSettings,
} from "../../auto-reply/reply/session-event-policy-inheritance.js";
import type { SessionEntriesCurrentCheck } from "../../config/sessions/session-entry-current.types.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.types.js";
import type {
  GatewayContextResolver,
  TrustedAgentToolCaller,
} from "../../gateway/server-methods/types.js";
import type { GatewayUiCommandTarget } from "../../gateway/ui-command-target.types.js";
import type { WorkerSessionTurnClaim } from "../../gateway/worker-environments/placement-record.js";
import type { WorkerTurnExecutionIdentityCapability } from "../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  captureGatewayContextResolver,
  getGatewayContextResolver,
} from "../../plugins/runtime/gateway-context-binding.js";
import { assertParticipationToolUser } from "../../security/dangerous-tools.js";
import type { ReplyTurnParticipants } from "../../sessions/session-controller.contracts.js";
import type { SessionControllerWatchdogAttempt } from "../../sessions/session-controller.watchdog.js";
// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncContext } from "../../shared/async-context.js";
import { runWithAsyncStore } from "../../shared/async-store.js";
import {
  resolveAdmittedRunActiveAssertion,
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
  type AdmittedRunContext,
  type OperationalRunInstanceRef,
} from "../admitted-run-context.js";
import type { WebchatMcpRequester } from "../agent-bundle-mcp-webchat-requester.types.js";
import { wrapAgentToolExecutionContext } from "../agent-tool-metadata.js";
import {
  captureActiveEmbeddedRunPersonalToolParticipants,
  type EmbeddedRunToolAuthorityBinding,
} from "../embedded-agent-runner/run-state.js";
import {
  captureRequesterOrigin,
  requesterCreatorProfileId,
  type RequesterOrigin,
} from "../requester-origin.js";
import { readToolStringParam, type AnyAgentTool } from "./common.js";
import type { GatewayToolCallerSource } from "./gateway-caller-context.types.js";
import type { GatewayToolCallerReceiptAdmission } from "./gateway-caller-receipt.types.js";

type GatewayToolCallerIdentity = {
  /** Exact direct-turn owner captured before private harness state is projected away. */
  webchatMcpRequester?: WebchatMcpRequester;
  watchdogAttempt?: SessionControllerWatchdogAttempt;
  personalToolParticipants?: ReplyTurnParticipants;
  personalToolUser?: string;
  personalToolIdentityScoped?: true;
  personalToolSelection?: GatewayToolOperatorSelection;
  agentId: string;
  sessionKey: string;
  requesterOrigin?: RequesterOrigin;
  /** Restrict-only executable surface captured for internal follow-ups. */
  sessionEventToolsAllow?: readonly string[];
  /** The surface restates this caller session's own policy; follow-ups to that session skip it. */
  sessionEventToolsAllowSessionScoped?: true;
  /** An object with no mode retains the producer's default permission posture. */
  sessionEventSettings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">>;
  /** Follow-ups cannot add automatic delivery to a message-tool-only source. */
  sessionEventDelivery?: false;
  gatewayUiCommandTarget?: GatewayUiCommandTarget;
  /** Prepared requesting-tool posture; absent authority never bypasses approvals. */
  fullPermission?: boolean;
  /** Host-held current delegation grant. A posture boolean alone never authorizes a write. */
  assertAutoApproveChangesCurrent?: () => void;
  operationalRunInstance?: OperationalRunInstanceRef;
  embeddedRunToolAuthorityBinding?: EmbeddedRunToolAuthorityBinding;
  /** Exact run authority used to fence delegated system-agent approvals. */
  approvalAuthority?: AgentRunDelegatedAuthority;
  /** Original operator restriction, separate from this tool/turn's execution lifetime. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Exact host-resolved owner of this individual approval request. */
  approvalOwnerPluginId?: string;
  /** Host-owned tool/turn lifetimes; every same-run wrapper preserves earlier fences. */
  approvalSignals?: readonly AbortSignal[];
  /** Opaque already-signed identity used only by isolated worker transports. */
  signedAgentRuntimeIdentityToken?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  /** Synchronous host-owned fence for tool effects and decision receipts. */
  receiptAuthority?: SessionSourceAssertion;
  receiptAdmissions?: readonly GatewayToolCallerReceiptAdmission[];
  /** Captured conversation policy for tools delegated through another tool's transport. */
  assertToolAllowed?: (toolName: string) => void;
  /** Exact Gateway-owned worker claim; never sourced from model or RPC arguments. */
  workerTurnClaim?: WorkerSessionTurnClaim;
  /** Prepared caller sandbox for the explicit current-workspace base refresh; never RPC data. */
  workspaceBaseRefreshSandbox?: import("../sandbox/types.js").SandboxContext;
  /** Host handoff selects the exact settled conversation; never accepted from RPC input. */
  workspacePrAdoptionSessionId?: string;
  /** Reporting attribution only; never restores the yielding turn's execution authority. */
  workspacePublicationRunId?: string;
  /** Effective requesting surface captured by local publication before yielding. */
  workspacePublicationPolicy?: {
    allow: string[];
    deny: string[];
    permissionMode?: SessionEntry["permissionMode"];
  };
  /** Current tool's filesystem owner for inspected PR evidence; never serialized in RPC data. */
  workspaceEvidenceSandbox?: import("../sandbox/types.js").SandboxContext;
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
  // Trusted run context, carried separately from model-authored tool arguments.
  turnSourceChannel?: string;
  turnSourceLocal?: true;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

const gatewayToolCallerStorage = new AsyncContext<GatewayToolCallerIdentity>(
  Symbol("gatewayToolCaller"),
);

const receiptAdmissionStorage = new AsyncContext<
  ReadonlyMap<GatewayToolCallerReceiptAdmission, () => boolean>
>(Symbol("gatewayToolReceiptAdmission"));

export function evaluateGatewayToolCallerReceiptAdmission(
  admission: GatewayToolCallerReceiptAdmission,
  otherwise: () => boolean,
): boolean {
  return (receiptAdmissionStorage.getStore()?.get(admission) ?? otherwise)();
}

export type GatewayToolOperatorSelection = Readonly<{
  /** Raw host-issued source; custody transfers must not retain the turn-bound assertion. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  requesterOrigin?: RequesterOrigin;
  assertCurrent: () => void;
}>;

type AdmittedGatewayToolCallerParams = {
  admittedRunContext: AdmittedRunContext;
  requesterOrigin?: RequesterOrigin;
  receiptAuthority?: SessionSourceAssertion;
  receiptAdmission?: GatewayToolCallerReceiptAdmission;
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

function composeReceiptAuthority(...sources: Array<SessionSourceAssertion | undefined>) {
  const unique = [...new Set(sources.filter((source) => source !== undefined))];
  return unique.length
    ? Object.assign(composeSessionSourceAssertion(unique), {
        assertScopeCurrent: () => {
          for (const source of unique) {
            (source.assertScopeCurrent ?? source)();
          }
        },
      })
    : undefined;
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
    requesterOrigin: captureRequesterOrigin({ requesterOrigin: params.requesterOrigin }),
    operationalRunInstance: params.admittedRunContext.operationalRunInstance,
    ...(delegatedAuthority ? { approvalAuthority: delegatedAuthority } : {}),
    ...(operatorAuthority ? { operatorAuthority } : {}),
    executionIdentityToken: params.admittedRunContext.executionIdentityToken,
    gatewayContextResolver: captureGatewayContextResolver(
      getGatewayContextResolver(params.admittedRunContext),
    ),
    receiptAuthority: composeReceiptAuthority(
      resolveAdmittedRunActiveAssertion(params.admittedRunContext) ??
        (() => {
          throw new Error("The agent run ended. Start a new turn to retry.");
        }),
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

/** The requester a retained continuation re-entered, for its next agent admission. */
export function readRetainedRequesterToolCaller(): TrustedAgentToolCaller | undefined {
  const caller = getGatewayToolCallerIdentity();
  const selection = caller?.personalToolIdentityScoped ? caller.personalToolSelection : undefined;
  return caller && selection
    ? {
        agentId: caller.agentId,
        sessionKey: caller.sessionKey,
        requesterOrigin: selection.requesterOrigin,
        assertCurrent: selection.assertCurrent,
      }
    : undefined;
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
  return await runWithAsyncStore(
    gatewayToolCallerStorage,
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
export function resolveGatewayToolOperatorSelection(options?: {
  requireRequesterOrigin?: boolean;
}): GatewayToolOperatorSelection {
  const caller = getGatewayToolCallerIdentity();
  let selection = caller?.personalToolSelection;
  if (!selection) {
    const participant =
      caller?.personalToolUser !== undefined ? resolveGatewayPersonalToolParticipant() : undefined;
    assertParticipationToolUser(participant?.profileId, caller?.operatorAuthority);
    const selectedParticipant =
      participant?.profileId !== caller?.operatorAuthority?.profileId ? participant : undefined;
    const operatorAuthority = selectedParticipant?.operatorAuthority ?? caller?.operatorAuthority;
    selection = Object.freeze({
      operatorAuthority,
      requesterOrigin: selectedParticipant?.requesterOrigin
        ? captureRequesterOrigin({
            requesterOrigin: {
              ...selectedParticipant.requesterOrigin,
              delegatedCreatorProfileId: requesterCreatorProfileId(caller?.requesterOrigin) ?? null,
            },
          })
        : selectedParticipant
          ? undefined
          : caller?.requesterOrigin,
      assertCurrent: composeSessionSourceAssertion([participant?.assertCurrent]),
    });
    if (caller?.personalToolIdentityScoped) {
      caller.personalToolSelection = selection;
    }
  }
  if (
    options?.requireRequesterOrigin &&
    selection.operatorAuthority &&
    selection.operatorAuthority.profileId !== caller?.operatorAuthority?.profileId &&
    selection.requesterOrigin?.operatorProfileId !== selection.operatorAuthority.profileId
  ) {
    throw new Error("Selected user's requester identity is unavailable; ask them in a new turn.");
  }
  return selection;
}

/** The accepting collector already holds this source independently of the spawning turn. */
export function withGatewayToolOperatorContinuation<T>(
  selection: Pick<GatewayToolOperatorSelection, "operatorAuthority" | "requesterOrigin">,
  run: () => T,
): T {
  const caller = getGatewayToolCallerIdentity();
  if (!caller) {
    return run();
  }
  const { operatorAuthority, requesterOrigin } = selection;
  return runWithAsyncStore(
    gatewayToolCallerStorage,
    {
      ...caller,
      personalToolParticipants: undefined,
      webchatMcpRequester: undefined,
      personalToolUser: undefined,
      personalToolIdentityScoped: true,
      // The accepting collector holds this source; no participant is selected here.
      personalToolSelection: Object.freeze({
        operatorAuthority,
        requesterOrigin,
        assertCurrent: composeSessionSourceAssertion([]),
      }),
    },
    run,
  );
}

export function resolveGatewayPersonalToolParticipant(
  runtimeIdentity?: AgentRuntimeIdentity,
  options?: { requireSingleParticipant?: boolean },
) {
  const caller = getGatewayToolCallerIdentity();
  if (caller?.personalToolParticipants) {
    return caller.personalToolParticipants.resolve(
      options?.requireSingleParticipant ? undefined : caller.personalToolUser,
    );
  }
  if (caller?.personalToolUser !== undefined) {
    throw new Error("Selecting user requires an active personal-tool turn.");
  }
  if (runtimeIdentity) {
    const registered = captureActiveEmbeddedRunPersonalToolParticipants(runtimeIdentity);
    if (!registered) {
      return undefined;
    }
    const participant = registered.participants?.resolve();
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

/** Watch admission preserves opaque lifecycle assertions while moving registered row predicates. */
export async function prepareGatewayToolCallerAssertion(): Promise<{
  assertCurrent?: () => void;
  sessionEntriesCurrent?: SessionEntriesCurrentCheck;
  release(): void;
}> {
  const caller = getGatewayToolCallerIdentity();
  const stopSignals = caller?.operationalRunInstance ? caller.approvalSignals : undefined;
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
    runWithAsyncStore(receiptAdmissionStorage, predicates, () =>
      stopSignals?.forEach((signal) => signal.throwIfAborted()),
    );
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
  const inheritedValue = <K extends keyof GatewayToolCallerIdentity>(key: K) =>
    inheritedOwner?.[key] ?? identity[key];
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
  return await runWithAsyncStore(
    gatewayToolCallerStorage,
    {
      agentId: inheritedOwner?.agentId ?? identity.agentId.trim(),
      sessionKey: inheritedOwner?.sessionKey ?? identity.sessionKey.trim(),
      watchdogAttempt: identity.watchdogAttempt ?? inheritedOwner?.watchdogAttempt,
      requesterOrigin: inheritedOwner?.requesterOrigin ?? identity.requesterOrigin,
      sessionEventDelivery:
        inheritedOwner?.sessionEventDelivery === false || identity.sessionEventDelivery === false
          ? false
          : undefined,
      sessionEventSettings:
        identity.sessionEventSettings && inheritedOwner?.sessionEventSettings
          ? narrowSessionEventSettings(
              inheritedOwner.sessionEventSettings,
              identity.sessionEventSettings,
            )
          : (identity.sessionEventSettings ?? inheritedOwner?.sessionEventSettings),
      ...inheritSessionEventToolPolicy(identity, inheritedOwner),
      workspaceBaseRefreshSandbox: inheritedValue("workspaceBaseRefreshSandbox"),
      workspacePrAdoptionSessionId: inheritedValue("workspacePrAdoptionSessionId"),
      workspacePublicationRunId: inheritedValue("workspacePublicationRunId"),
      workspacePublicationPolicy: inheritedValue("workspacePublicationPolicy"),
      workspaceEvidenceSandbox: inheritedValue("workspaceEvidenceSandbox"),
      personalToolParticipants: inheritedValue("personalToolParticipants"),
      webchatMcpRequester: Object.hasOwn(identity, "webchatMcpRequester")
        ? identity.webchatMcpRequester
        : inheritedOwner?.webchatMcpRequester,
      personalToolUser: inheritedValue("personalToolUser"),
      personalToolIdentityScoped: inheritedValue("personalToolIdentityScoped"),
      personalToolSelection: inheritedValue("personalToolSelection"),
      // Same-run wrappers can narrow a prepared posture, never erase a restriction.
      fullPermission:
        inheritedOwner?.fullPermission === false || identity.fullPermission === false
          ? false
          : inheritedValue("fullPermission"),
      assertAutoApproveChangesCurrent:
        inheritedOwner?.assertAutoApproveChangesCurrent || identity.assertAutoApproveChangesCurrent
          ? () => {
              inheritedOwner?.assertAutoApproveChangesCurrent?.();
              identity.assertAutoApproveChangesCurrent?.();
            }
          : undefined,
      operationalRunInstance: inheritedValue("operationalRunInstance"),
      embeddedRunToolAuthorityBinding:
        identity.embeddedRunToolAuthorityBinding ?? inheritedOwner?.embeddedRunToolAuthorityBinding,
      approvalAuthority,
      operatorAuthority: inheritedValue("operatorAuthority"),
      approvalOwnerPluginId:
        identity.approvalOwnerPluginId?.trim() ||
        inheritedOwner?.approvalOwnerPluginId ||
        undefined,
      signedAgentRuntimeIdentityToken:
        (inheritedOwner?.signedAgentRuntimeIdentityToken ??
          identity.signedAgentRuntimeIdentityToken?.trim()) ||
        undefined,
      cronSelfManagementJobId:
        (identity.cronSelfManagementJobId?.trim() ?? inheritedOwner?.cronSelfManagementJobId) ||
        undefined,
      cronToolsAllowCapture:
        identity.cronToolsAllowCapture ?? inheritedOwner?.cronToolsAllowCapture,
      cronExecToolTarget: identity.cronExecToolTarget ?? inheritedOwner?.cronExecToolTarget,
      cronCreatorAuthorityGrant:
        identity.cronCreatorAuthorityGrant ?? inheritedOwner?.cronCreatorAuthorityGrant,
      mintCronRequesterGrant: inheritedValue("mintCronRequesterGrant"),
      cronManagementGrant: identity.cronManagementGrant ?? inheritedOwner?.cronManagementGrant,
      executionIdentityToken: inheritedValue("executionIdentityToken"),
      receiptAuthority: composeReceiptAuthority(
        inheritedOwner?.receiptAuthority,
        identity.receiptAuthority,
      ),
      receiptAdmissions: receiptAdmissions.length ? receiptAdmissions : undefined,
      assertToolAllowed,
      approvalSignals: approvalSignals.length ? approvalSignals : undefined,
      workerTurnClaim: inheritedValue("workerTurnClaim"),
      workerTurnExecutionIdentityCapability: inheritedValue(
        "workerTurnExecutionIdentityCapability",
      ),
      gatewayContextResolver:
        inheritedOwner?.gatewayContextResolver ??
        captureGatewayContextResolver(identity.gatewayContextResolver),
      gatewayUiCommandTarget: inheritedValue("gatewayUiCommandTarget"),
      turnSourceChannel:
        (inheritedOwner?.turnSourceChannel ?? identity.turnSourceChannel?.trim()) || undefined,
      turnSourceLocal: inheritedValue("turnSourceLocal"),
      turnSourceTo: (inheritedOwner?.turnSourceTo ?? identity.turnSourceTo?.trim()) || undefined,
      turnSourceAccountId:
        (inheritedOwner?.turnSourceAccountId ?? identity.turnSourceAccountId?.trim()) || undefined,
      turnSourceThreadId: inheritedValue("turnSourceThreadId"),
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
  return wrapAgentToolExecutionContext(
    tool,
    (...args) => withGatewayToolCallerIdentity(identity, () => tool.execute?.(...args)),
    (operation) => withGatewayToolCallerIdentity(identity, operation),
    (source) => wrapToolWithGatewayCallerIdentity(source, identity),
  );
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
