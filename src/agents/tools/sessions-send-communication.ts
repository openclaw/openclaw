import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { createRuntimeConfigReader } from "../../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindInProcessSessionRun } from "../../gateway/in-process-session-run.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
} from "../../gateway/in-process-subagent-resume.js";
import { requestSessionCommunicationApproval } from "../../gateway/session-communication-approval.js";
import { withSessionSendDelivery } from "../../gateway/session-send-delivery.js";
import { assertParentSubagentResumeSuccessorCurrent } from "../../gateway/session-subagent-resume.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  communicationEndpointBinding,
  communicationEntryBinding,
  planSessionCommunication,
  type CommunicationEndpoint,
  type CommunicationApproval,
} from "../../sessions/communication-admission.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../../sessions/session-row-changes.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../embedded-agent-runner/run-state.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../subagents/registry/subagent-registry-read.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import {
  getInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  createAgentToAgentPolicy,
  formatSessionToolAccessDenial,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolAccess,
} from "./sessions-access.js";
import { readSessionCommunicationEndpoint } from "./sessions-send-communication-endpoint.js";

/** A current permission decision rejected delivery, rather than an unavailable dependency. */
export class SessionCommunicationDeniedError extends Error {}

/** A host-held return route minted only after the original request was accepted. */
export type SessionSendReplyAdmission = (
  source: CommunicationEndpoint,
  target: CommunicationEndpoint,
) => void;

/** One prepared peer operation; identity bounds never choose its completion route. */
export async function prepareSessionsSendCommunication(params: {
  config: OpenClawConfig;
  source: CommunicationEndpoint;
  target: CommunicationEndpoint;
  message: string;
  /** Host annotation and source identity checked at the final admission boundary. */
  dispatchMessage?: string;
  inputProvenance?: InputProvenance;
  access?: {
    sandboxed?: boolean;
    watch?: boolean;
    requesterOwned?: boolean;
    authorizationTargetSessionKey?: string;
    expectedSessionId?: string;
  };
  /** Creates empty metadata through the caller's existing creation owner, never model input. */
  ensureTarget?: (assertCurrent: () => void) => Promise<CommunicationEndpoint>;
  signal?: AbortSignal;
  /** Recovery cannot ask for fresh consent on behalf of an ended sender turn. */
  allowApproval?: boolean;
  assertSourceCurrent?: () => void;
  assertAccessCurrent?: () => void;
  /** An accepted request's result is not a fresh reverse-direction send. */
  acceptedReply?: SessionSendReplyAdmission;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  const message = params.message;
  const dispatchMessage = params.dispatchMessage ?? message;
  const inputProvenance = params.inputProvenance;
  const targetAgentId = params.target.agentId;
  const targetSessionKey = params.target.sessionKey;
  const targetsThread = Boolean(resolveSessionThreadInfo(targetSessionKey).threadId);
  const caller = getGatewayToolCallerIdentity();
  const assertCaller = captureGatewayToolCallerAssertion();
  const context = getInProcessGatewayToolContext();
  // Never replace the config against which identities and source ceilings were prepared.
  const config = params.config;
  const readConfig = createRuntimeConfigReader(config);
  const currentPolicyConfig = () => context?.getRuntimeConfig() ?? readConfig();
  const currentConfig = currentPolicyConfig();
  const policyConfigs = config === currentConfig ? [config] : [config, currentConfig];
  const sandboxed =
    params.access?.sandboxed === true ||
    policyConfigs.some(
      (policyConfig) =>
        resolveSandboxRuntimeStatus({
          cfg: policyConfig,
          agentId: params.source.agentId,
          sessionKey: params.source.sessionKey,
          preparedSessionEntry: params.source.entry ?? null,
        }).sandboxed,
    );
  const accessPolicies = policyConfigs.map((policyConfig) => ({
    scope: resolveSandboxedSessionToolContext({
      cfg: policyConfig,
      agentSessionKey: params.source.sessionKey,
      requesterAgentId: params.source.agentId,
      sandboxed,
    }),
    visibility: resolveEffectiveSessionToolsVisibility({ cfg: policyConfig, sandboxed }),
    a2aPolicy: createAgentToAgentPolicy(policyConfig, { sandboxed }),
  }));
  let acceptedRunId: string | undefined;
  let closed = false;
  let dirty = false;
  // Only the compaction owner can clear a matching committed binding change.
  const changedBindings = new Map<CommunicationEndpoint, string>();
  let currentTarget = params.target;
  let creatingTarget = false;
  let endpoints: CommunicationEndpoint[] = [params.source, params.target];
  const assertSource = () => {
    if (closed) {
      throw new Error("Session communication admission closed.");
    }
    params.signal?.throwIfAborted();
    assertCaller?.();
    params.assertSourceCurrent?.();
    params.assertAccessCurrent?.();
    params.acceptedReply?.(params.source, currentTarget);
    if (currentPolicyConfig() !== currentConfig) {
      throw new Error("Communication policy changed; send the message again for a new decision.");
    }
    // The tool preflight may have captured an older opt-in. Admission owns the
    // current destination policy, including fallbacks and the final commit guard.
    if (
      !params.acceptedReply &&
      targetsThread &&
      policyConfigs.some(
        (policyConfig) => policyConfig.tools?.sessions?.allowThreadTargets !== true,
      )
    ) {
      throw new Error(
        "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead, or enable tools.sessions.allowThreadTargets.",
      );
    }
  };
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      !sessionChangeScopeAffectsStoredRows(change) &&
      !("all" in change && change.scope === "config")
    ) {
      return;
    }
    if ("all" in change) {
      // Creating the selected target can register its first physical store.
      // The post-creation refresh still verifies every endpoint binding.
      if (
        creatingTarget &&
        typeof change.scope === "object" &&
        change.scope.topology === true &&
        change.scope.agentId === targetAgentId
      ) {
        return;
      }
      dirty = true;
      return;
    }
    const selected = endpoints.filter(
      (endpoint) =>
        endpoint.sessionKey === change.sessionKey &&
        (!change.agentId || endpoint.agentId === change.agentId) &&
        !(
          creatingTarget &&
          !endpoint.entry &&
          endpoint.agentId === targetAgentId &&
          endpoint.sessionKey === targetSessionKey
        ),
    );
    if (
      !selected.length ||
      // Metadata notifications (including worker turn claims) do not replace stored policy.
      (!change.facts && !change.factsInvalidated) ||
      change.facts?.kind === "unchanged" ||
      change.facts?.kind === "participants" ||
      change.facts?.kind === "category"
    ) {
      return;
    }
    const facts = change.facts;
    if (
      (facts?.kind === "entry" || facts?.kind === "replacement") &&
      facts.communicationBinding !== undefined
    ) {
      for (const endpoint of selected) {
        if (communicationEntryBinding(endpoint.entry) !== facts.communicationBinding) {
          const previous = changedBindings.get(endpoint);
          if (previous !== undefined && previous !== facts.communicationBinding) {
            dirty = true;
          }
          changedBindings.set(endpoint, facts.communicationBinding);
        }
      }
    } else {
      dirty = true;
    }
  });
  const read = (endpoint: CommunicationEndpoint) =>
    readSessionCommunicationEndpoint({
      config: currentConfig,
      endpoint,
      assertCurrent: assertSource,
    });
  const lineage = async (endpoint: CommunicationEndpoint) => {
    const chain = [endpoint];
    while (chain.at(-1)?.entry?.spawnedBy) {
      const child = chain.at(-1)!;
      const key = child.entry!.spawnedBy!;
      if (chain.length >= 32 || chain.some((entry) => entry.sessionKey === key)) {
        throw new Error("Session communication ancestry is invalid.");
      }
      const parent = await read({
        agentId: parseAgentSessionKey(key)?.agentId ?? child.agentId,
        sessionKey: key,
        storePath: "",
        entry: undefined,
      });
      if (
        !parent.entry ||
        (child.entry?.parentSessionId && child.entry.parentSessionId !== parent.entry.sessionId)
      ) {
        throw new Error("The communication policy's parent session is no longer current.");
      }
      chain.push(parent);
    }
    return chain;
  };
  const task = getLatestLiveSubagentRunByChildSessionKey(
    params.target.sessionKey,
    undefined,
    params.target.agentId,
  );
  const ownedTask = Boolean(
    caller &&
    caller.agentId === params.source.agentId &&
    caller.sessionKey === params.source.sessionKey &&
    task &&
    task.requesterSessionKey === params.source.sessionKey &&
    task.requesterAgentId === params.source.agentId &&
    (!task.controllerSessionKey || task.controllerSessionKey === params.source.sessionKey) &&
    (!task.execution?.transcriptTarget ||
      task.execution.transcriptTarget.sessionId === params.target.entry?.sessionId) &&
    params.target.entry?.spawnedBy === params.source.sessionKey &&
    params.target.entry.parentSessionId === params.source.entry?.sessionId &&
    !task.killIntent &&
    !task.killReconciliation &&
    !task.terminalOwner &&
    task.cleanupCompletedAt === undefined,
  );
  const taskRunId = task?.runId;
  const taskGeneration = task?.generation;
  let resumedTask:
    | { resume: NonNullable<ReturnType<typeof readInProcessSubagentResume>>; runId: string }
    | undefined;
  const assertTask = () => {
    if (
      ownedTask &&
      (getLatestLiveSubagentRunByChildSessionKey(
        params.target.sessionKey,
        undefined,
        params.target.agentId,
      ) !== task ||
        task?.runId !== taskRunId ||
        task?.generation !== taskGeneration ||
        (task?.controllerSessionKey && task.controllerSessionKey !== params.source.sessionKey) ||
        task?.killIntent ||
        task?.killReconciliation ||
        task?.terminalOwner ||
        task?.cleanupCompletedAt !== undefined)
    ) {
      if (resumedTask) {
        assertParentSubagentResumeSuccessorCurrent(resumedTask.resume, resumedTask.runId);
        return;
      }
      throw new Error("Owned task communication authority changed.");
    }
  };
  const close = () => {
    if (!closed) {
      closed = true;
      unsubscribe();
    }
  };
  try {
    assertSource();
    let source = await lineage(params.source);
    let target = await lineage(params.target);
    endpoints = [...source, ...target];
    let bindings = endpoints.map(communicationEndpointBinding);
    const assertAccess = async () => {
      assertSource();
      if (params.acceptedReply) {
        return;
      }
      for (const { scope, visibility, a2aPolicy } of accessPolicies) {
        const decision = await resolveSessionToolAccess({
          action: "send",
          watch: params.access?.watch,
          requesterAgentId: params.source.agentId,
          requesterSessionKey: params.source.sessionKey,
          mainSessionKey: scope.mainSessionKey,
          targetAgentId: target[0]!.agentId,
          targetSessionKey: target[0]!.sessionKey,
          authorizationTargetSessionKey:
            params.access?.authorizationTargetSessionKey ??
            (parseAgentSessionKey(target[0]!.sessionKey)
              ? target[0]!.sessionKey
              : "agent:" + target[0]!.agentId + ":" + target[0]!.sessionKey),
          requesterOwned:
            params.access?.requesterOwned === true ||
            target[0]!.entry?.spawnedBy === params.source.sessionKey,
          visibility,
          a2aPolicy,
          callGateway: params.callGateway,
        });
        assertSource();
        if (!decision.allowed) {
          throw new SessionCommunicationDeniedError(
            formatSessionToolAccessDenial(decision, {
              action: "send",
              targetSessionKey: target[0]!.sessionKey,
            }),
          );
        }
        const expected = decision.expectedSessionId ?? params.access?.expectedSessionId;
        if (expected && target[0]!.entry?.sessionId !== expected) {
          throw new Error(
            "Session communication access grant no longer names the prepared target.",
          );
        }
      }
    };
    const refresh = async () => {
      assertSource();
      assertTask();
      if (dirty || changedBindings.size > 0) {
        throw new Error(
          "Session communication changed before delivery; send again for a new decision.",
        );
      }
      const current = await Promise.all(endpoints.map(read));
      await assertAccess();
      if (
        dirty ||
        changedBindings.size > 0 ||
        current.some(
          (endpoint, index) => communicationEndpointBinding(endpoint) !== bindings[index],
        )
      ) {
        throw new Error(
          "Session communication changed before delivery; no message was authorized for the new state.",
        );
      }
    };
    const plan = () => {
      if (params.acceptedReply) {
        return { approvals: [] };
      }
      const approvals = new Map<string, CommunicationApproval>();
      for (const policyConfig of policyConfigs) {
        const result = planSessionCommunication({
          config: policyConfig,
          source,
          target,
          ownedTask,
        });
        if (!result.allowed) {
          throw new SessionCommunicationDeniedError(result.error);
        }
        for (const approval of result.approvals) {
          approvals.set(
            JSON.stringify([
              approval.direction,
              approval.endpoint.agentId,
              approval.endpoint.sessionKey,
            ]),
            approval,
          );
        }
      }
      return { approvals: [...approvals.values()] };
    };
    // Never in either direction precedes questions and creation, even for missing configured-main targets.
    const initialPlan = plan();
    await refresh();
    const approve = async (approval: (typeof initialPlan.approvals)[number]) => {
      if (params.allowApproval === false) {
        throw new SessionCommunicationDeniedError(
          "Session delivery requires fresh human communication approval.",
        );
      }
      await refresh();
      if (!context || (!assertCaller && !params.assertSourceCurrent)) {
        throw new Error("Human communication approval requires a live admitted Gateway caller.");
      }
      await requestSessionCommunicationApproval({
        context,
        approval,
        source: params.source,
        target: target[0]!,
        message,
        assertCurrent: () => {
          assertSource();
          assertTask();
          if (dirty || changedBindings.size > 0) {
            throw new Error("Session communication state changed before approval.");
          }
        },
        signal: params.signal,
        requesterRun: caller?.operationalRunInstance,
        registerHumanInputWait: caller?.approvalAuthority
          ? (pending) => registerActiveEmbeddedRunHumanInputWait(caller.approvalAuthority!, pending)
          : undefined,
      });
      await refresh();
    };
    for (const approval of initialPlan.approvals.filter((item) => item.direction === "send")) {
      await approve(approval);
    }
    if (!target[0]!.entry) {
      if (!params.ensureTarget) {
        throw new Error("Communication requires an existing target session.");
      }
      await refresh();
      // The existing creation owner may publish empty metadata before its RPC settles.
      // Bind that row after creation, while continuing to fence every source/ancestor change.
      creatingTarget = true;
      let created: CommunicationEndpoint;
      try {
        created = await params.ensureTarget(() => {
          assertSource();
          if (dirty || changedBindings.size > 0) {
            throw new Error("Session communication state changed before creation.");
          }
        });
      } finally {
        creatingTarget = false;
      }
      assertSource();
      if (
        !created.entry ||
        created.agentId !== params.target.agentId ||
        created.sessionKey !== params.target.sessionKey
      ) {
        throw new Error("Created target differs from the approved communication operation.");
      }
      target = await lineage(created);
      // An initially absent main alias can name both sides of this creation.
      if (
        !source[0]!.entry &&
        source[0]!.agentId === created.agentId &&
        source[0]!.sessionKey === created.sessionKey &&
        source[0]!.storePath === created.storePath
      ) {
        source = target;
      }
      endpoints = [...source, ...target];
      bindings = endpoints.map(communicationEndpointBinding);
      // Receiver consent belongs to the created exact incarnation, not a substitute source session.
      plan();
      await refresh();
    }
    for (const approval of plan().approvals.filter((item) => item.direction === "receive")) {
      await approve(approval);
    }
    const assertCurrent: SessionSourceAssertion = () => {
      assertSource();
      assertTask();
      if (dirty || changedBindings.size > 0) {
        throw new Error("Session communication state changed before admission.");
      }
    };
    assertCurrent.onSessionCompactionCommitted = (transition, entry) => {
      const previous = target[0]!;
      const expected = previous.entry;
      if (
        !expected ||
        entry.sessionId !== transition.current.sessionId ||
        entry.lifecycleRevision !== transition.current.lifecycleRevision ||
        entry.lifecycleRevision !== expected.lifecycleRevision ||
        communicationEntryBinding({ ...entry, sessionId: expected.sessionId }) !==
          communicationEntryBinding(expected) ||
        (expected.sessionId !== entry.sessionId &&
          (transition.previous?.sessionId !== expected.sessionId ||
            transition.previous.lifecycleRevision !== expected.lifecycleRevision))
      ) {
        throw new Error("Compaction no longer names the admitted communication target.");
      }
      const previousBinding = communicationEndpointBinding(previous);
      const committedBinding = communicationEntryBinding(entry);
      const advance = (endpoint: CommunicationEndpoint) => {
        if (communicationEndpointBinding(endpoint) !== previousBinding) {
          return endpoint;
        }
        // The compaction owner alone authorizes this identity change. Other facts stay sticky.
        if (changedBindings.get(endpoint) === committedBinding) {
          changedBindings.delete(endpoint);
        }
        return { ...endpoint, entry };
      };
      source = source.map(advance);
      target = target.map(advance);
      currentTarget = target[0]!;
      endpoints = [...source, ...target];
      bindings = endpoints.map(communicationEndpointBinding);
    };
    await refresh();
    const callGateway = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
      requireDurableDelivery = false,
    ): Promise<T> => {
      if (request.method !== "agent") {
        return params.callGateway<T>(request);
      }
      await refresh();
      if (
        !isRecord(request.params) ||
        request.params.sessionKey !== targetSessionKey ||
        request.params.agentId !== targetAgentId ||
        request.params.message !== dispatchMessage ||
        !isDeepStrictEqual(request.params.inputProvenance, inputProvenance)
      ) {
        throw new Error("Communication approval cannot be redirected to another session.");
      }

      const runId = request.params.idempotencyKey;
      const hasRunId = typeof runId === "string";
      const resume = readInProcessSubagentResume(request);
      if (ownedTask && resume && hasRunId) {
        if (
          resume.childSessionKey !== targetSessionKey ||
          resume.childSessionId !== target[0]!.entry?.sessionId ||
          resume.previousRunId !== taskRunId ||
          resume.generation !== taskGeneration
        ) {
          throw new Error("Task resume differs from the captured communication owner.");
        }
        resumedTask = { resume, runId };
      }
      const endpoint = target[0]!;
      if (
        !endpoint.entry ||
        (request.params.expectedExistingSessionId !== undefined &&
          request.params.expectedExistingSessionId !== endpoint.entry.sessionId)
      ) {
        throw new Error("Communication target incarnation changed before admission.");
      }
      let input: Record<string, unknown> = {
        ...request.params,
        expectedExistingSessionId: endpoint.entry.sessionId,
        expectedExistingSessionLifecycleRevision: endpoint.entry.lifecycleRevision ?? null,
      };
      if (context && hasRunId) {
        input = bindInProcessSessionRun(input, {
          sessionKey: targetSessionKey,
          sessionId: endpoint.entry.sessionId,
          lifecycleRevision: endpoint.entry.lifecycleRevision ?? null,
          runId,
        });
      }
      const expectedInput = structuredClone(input);
      const assertAdmission = () => {
        request.sessionMutationCommitGuard?.();
        assertCurrent();
        if (!isDeepStrictEqual(input, expectedInput)) {
          throw new Error("Approved communication input changed before admission.");
        }
      };
      const dispatch = async () => {
        const result = await params.callGateway<T>(
          bindInProcessSubagentResume(
            {
              ...request,
              params: input,
              // A standalone transport can fence submission, never serialize a host capability.
              ...(context
                ? { sessionMutationCommitGuard: assertAdmission }
                : {
                    assertDispatchCurrent: () => {
                      request.assertDispatchCurrent?.();
                      assertAdmission();
                    },
                  }),
            },
            resume,
          ),
        );
        if (
          isRecord(result) &&
          typeof result.runId === "string" &&
          result.admissionPending !== true
        ) {
          acceptedRunId = result.runId;
        }
        return result;
      };
      const sender = source[0]!;
      // A safely refused volatile steer needs pending-input recovery even for an
      // owned task. Resume keeps its existing task owner and never uses this path.
      if (
        context &&
        (!ownedTask || requireDurableDelivery) &&
        !resume &&
        sender.entry &&
        hasRunId &&
        inputProvenance?.sourceTool === "sessions_send"
      ) {
        return withSessionSendDelivery(
          {
            delivery: {
              version: 1,
              runId,
              source: {
                agentId: sender.agentId,
                sessionKey: sender.sessionKey,
                sessionId: sender.entry.sessionId,
                ...(sender.entry.lifecycleRevision === undefined
                  ? {}
                  : { lifecycleRevision: sender.entry.lifecycleRevision }),
              },
              target: {
                agentId: endpoint.agentId,
                sessionKey: endpoint.sessionKey,
                sessionId: endpoint.entry.sessionId,
                ...(endpoint.entry.lifecycleRevision === undefined
                  ? {}
                  : { lifecycleRevision: endpoint.entry.lifecycleRevision }),
              },
              sandboxed,
              message: dispatchMessage,
              ...(request.replyExpectation === "optional" &&
              typeof input.extraSystemPrompt === "string"
                ? { returnedResult: { extraSystemPrompt: input.extraSystemPrompt } }
                : {}),
            },
          },
          dispatch,
        );
      }
      if (requireDurableDelivery) {
        throw new Error("Durable steering fallback requires an in-process delivery owner.");
      }
      return dispatch();
    };
    return {
      admissionConfig: captureRuntimeConfig(currentConfig),
      assertCurrent,
      refresh,
      callGateway,
      callDurableGateway: <T>(request: Parameters<AgentToolGatewayRequestCaller>[0]) =>
        callGateway<T>(request, true),
      ownedTask,
      sourceSandboxed: sandboxed,
      captureReplyAdmission: (runId: string): SessionSendReplyAdmission => {
        if (acceptedRunId !== runId) {
          throw new Error("Requested reply has no accepted source request.");
        }
        const identity = (endpoint: CommunicationEndpoint) =>
          JSON.stringify([
            endpoint.agentId,
            endpoint.sessionKey,
            endpoint.storePath,
            endpoint.entry?.sessionId,
            endpoint.entry?.lifecycleRevision,
          ]);
        const requester = identity(source[0]!);
        const peer = identity(target[0]!);
        // This route outlives the sender tool; the continuation separately checks
        // live operator authority. It grants no unrelated peer send or history access.
        return (replySource, replyTarget) => {
          if (
            identity(replySource) !== peer ||
            identity(replyTarget) !== requester ||
            replySource.entry?.archivedAt !== undefined ||
            replyTarget.entry?.archivedAt !== undefined
          ) {
            throw new Error("Requested reply no longer names its accepted session incarnations.");
          }
        };
      },
      targetSession: target[0]!.entry
        ? {
            sessionId: target[0]!.entry.sessionId,
            lifecycleRevision: target[0]!.entry.lifecycleRevision,
          }
        : undefined,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
