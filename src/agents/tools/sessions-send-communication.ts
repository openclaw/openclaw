import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindSessionCommunicationInput } from "../../gateway/in-process-session-communication.js";
import {
  bindInProcessSubagentResume,
  readInProcessSubagentResume,
} from "../../gateway/in-process-subagent-resume.js";
import { requestSessionCommunicationApproval } from "../../gateway/session-communication-approval.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  communicationEndpointBinding,
  communicationEntryBinding,
  planSessionCommunication,
  type CommunicationEndpoint,
  type CommunicationApproval,
} from "../../sessions/communication-admission.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
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

/** One prepared peer operation; identity bounds never choose its completion route. */
export async function prepareSessionsSendCommunication(params: {
  config: OpenClawConfig;
  source: CommunicationEndpoint;
  target: CommunicationEndpoint;
  message: string;
  /** Host annotation and source identity checked before the input capability is bound. */
  dispatchMessage?: string;
  inputProvenance?: InputProvenance;
  access?: {
    sandboxed?: boolean;
    requesterOwned?: boolean;
    authorizationTargetSessionKey?: string;
    expectedSessionId?: string;
  };
  /** Creates empty metadata through the caller's existing creation owner, never model input. */
  ensureTarget?: (assertCurrent: () => void) => Promise<CommunicationEndpoint>;
  signal?: AbortSignal;
  assertSourceCurrent?: () => void;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  const message = params.message;
  const dispatchMessage = params.dispatchMessage ?? message;
  const inputProvenance = params.inputProvenance
    ? structuredClone(params.inputProvenance)
    : undefined;
  const targetAgentId = params.target.agentId;
  const targetSessionKey = params.target.sessionKey;
  const caller = getGatewayToolCallerIdentity();
  const assertCaller = captureGatewayToolCallerAssertion();
  const context = getInProcessGatewayToolContext();
  // Never replace the config against which identities and source ceilings were prepared.
  const config = params.config;
  const currentConfig = context?.getRuntimeConfig() ?? config;
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
    a2aPolicy: createAgentToAgentPolicy(policyConfig),
  }));
  let closed = false;
  let owners = 1;
  let dirty = false;
  let creatingTarget = false;
  let endpoints: CommunicationEndpoint[] = [params.source, params.target];
  const assertSource = () => {
    if (closed) {
      throw new Error("Session communication admission closed.");
    }
    params.signal?.throwIfAborted();
    assertCaller?.();
    params.assertSourceCurrent?.();
    if (context && context.getRuntimeConfig() !== currentConfig) {
      throw new Error("Communication policy changed; send the message again for a new decision.");
    }
  };
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if ("all" in change) {
      if (
        typeof change.scope === "string" &&
        [
          "profiles",
          "catalog",
          "acp",
          "agent-runs",
          "subagent-runs",
          "worker-placements",
          "worker-environments",
          "config",
          "config-presentation",
          "config-profiles",
        ].includes(change.scope)
      ) {
        return;
      }
      dirty = true;
      return;
    }
    if (!change.storePath || change.scope === "automation") {
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
      change.facts?.kind === "unchanged" ||
      change.facts?.kind === "participants" ||
      change.facts?.kind === "category"
    ) {
      return;
    }
    const facts = change.facts;
    if (facts?.kind === "entry" && facts.communicationBinding !== undefined) {
      dirty ||= selected.some(
        (endpoint) => communicationEntryBinding(endpoint.entry) !== facts.communicationBinding,
      );
    } else {
      dirty = true;
    }
  });
  const read = async (endpoint: CommunicationEndpoint): Promise<CommunicationEndpoint> => {
    const loaded = await resolveGatewaySessionStoreTargetInWorker({
      cfg: currentConfig,
      key: endpoint.sessionKey,
      agentId: endpoint.agentId,
      assertActive: assertSource,
    });
    return {
      agentId: loaded.agentId,
      sessionKey: loaded.canonicalKey,
      storePath: loaded.readSource?.path ?? loaded.storePath,
      entry: loaded.store[loaded.canonicalKey],
    };
  };
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
  const task = getLatestLiveSubagentRunByChildSessionKey(params.target.sessionKey);
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
  const assertTask = () => {
    if (
      ownedTask &&
      (getLatestLiveSubagentRunByChildSessionKey(params.target.sessionKey) !== task ||
        task?.runId !== taskRunId ||
        task?.generation !== taskGeneration ||
        (task?.controllerSessionKey && task.controllerSessionKey !== params.source.sessionKey) ||
        task?.killIntent ||
        task?.killReconciliation ||
        task?.terminalOwner ||
        task?.cleanupCompletedAt !== undefined)
    ) {
      throw new Error("Owned task communication authority changed.");
    }
  };
  const release = () => {
    if (--owners === 0) {
      unsubscribe();
    }
  };
  const close = () => {
    if (!closed) {
      closed = true;
      release();
    }
  };
  try {
    assertSource();
    const source = await lineage(params.source);
    let target = await lineage(params.target);
    endpoints = [...source, ...target];
    let bindings = endpoints.map(communicationEndpointBinding);
    const assertAccess = async () => {
      assertSource();
      for (const { scope, visibility, a2aPolicy } of accessPolicies) {
        const decision = await resolveSessionToolAccess({
          action: "send",
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
          throw new Error(
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
      dirty = false;
      const current = await Promise.all(endpoints.map(read));
      await assertAccess();
      if (
        dirty ||
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
      const approvals = new Map<string, CommunicationApproval>();
      for (const policyConfig of policyConfigs) {
        const result = planSessionCommunication({
          config: policyConfig,
          source,
          target,
          ownedTask,
        });
        if (!result.allowed) {
          throw new Error(result.error);
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
        assertCurrent: assertSource,
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
          if (dirty) {
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
      endpoints = [...source, ...target];
      bindings = endpoints.map(communicationEndpointBinding);
      // Receiver consent belongs to the created exact incarnation, not a substitute source session.
      plan();
      await refresh();
    }
    for (const approval of plan().approvals.filter((item) => item.direction === "receive")) {
      await approve(approval);
    }
    const assertInputCurrent = () => {
      if (owners === 0 || (context && context.getRuntimeConfig() !== currentConfig)) {
        throw new Error("Peer input policy custody is no longer current.");
      }
      if (dirty) {
        throw new Error("Session communication state changed before delivery.");
      }
    };
    const assertCurrent = () => {
      assertSource();
      assertTask();
      assertInputCurrent();
    };
    const retainInput = () => {
      assertCurrent();
      owners += 1;
      let released = false;
      return {
        assertCurrent: () => {
          if (released) {
            throw new Error("Peer input policy custody was released.");
          }
          assertInputCurrent();
        },
        release: () => {
          if (!released) {
            released = true;
            release();
          }
        },
      };
    };
    await refresh();
    const callGateway: AgentToolGatewayRequestCaller = async (request) => {
      if (request.method !== "agent") {
        return params.callGateway(request);
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
      bindSessionCommunicationInput(request.params, { retain: retainInput });
      return params.callGateway(
        bindInProcessSubagentResume(
          {
            ...request,
            sessionMutationCommitGuard: () => {
              request.sessionMutationCommitGuard?.();
              assertCurrent();
            },
          },
          readInProcessSubagentResume(request),
        ),
      );
    };
    return {
      assertCurrent,
      retainInput,
      refresh,
      callGateway,
      ownedTask,
      sourceSandboxed: sandboxed,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
