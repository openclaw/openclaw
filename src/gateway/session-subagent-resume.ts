/** Exact parent-owned paused-task binding for explicit model-tool resume admission. */
import {
  ensureSubagentControllerOwnsRun,
  resolveSubagentController,
} from "../agents/subagents/registry/subagent-control-scope.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TrustedSubagentResume } from "./in-process-subagent-resume.js";
import type { GatewayContextResolver, TrustedAgentToolCaller } from "./server-methods/types.js";

/** Select task continuation from recorded ownership; admission still binds and revalidates it. */
export function shouldResumeParentSubagent(params: {
  cfg: OpenClawConfig;
  caller: TrustedAgentToolCaller;
  childSessionKey: string;
}): boolean {
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    params.childSessionKey,
    (candidate) => candidate.pauseReason === "sessions_yield",
  );
  if (!entry || entry.expectsCompletionMessage !== true) {
    return false;
  }
  const controllerStorePath = entry.controllerSessionKey?.trim()
    ? entry.controllerStorePath
    : entry.requesterStorePath;
  if (controllerStorePath === undefined) {
    return false;
  }
  const controller = resolveSubagentController({
    cfg: params.cfg,
    agentId: params.caller.agentId,
    agentSessionKey: params.caller.sessionKey,
  });
  return (
    controller.controlScope === "children" &&
    ensureSubagentControllerOwnsRun({ cfg: params.cfg, controller, entry }) === undefined
  );
}

// Control ownership comes from the registry, not the child's key shape or message provenance.
function requirePausedChild(cfg: OpenClawConfig, caller: TrustedAgentToolCaller, key: string) {
  if (!caller.assertCurrent) {
    throw new Error("Task resume requires an admitted parent tool caller.");
  }
  caller.assertCurrent();
  const controller = resolveSubagentController({
    cfg,
    agentId: caller.agentId,
    agentSessionKey: caller.sessionKey,
  });
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    key,
    (candidate) => candidate.pauseReason === "sessions_yield",
  );
  if (
    !entry ||
    typeof entry.execution.endedAt !== "number" ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.terminalOwner ||
    entry.suppressAnnounceReason ||
    entry.cleanupCompletedAt !== undefined ||
    entry.execution.suppressSessionEffects
  ) {
    throw new Error(
      "Task resume requires a currently paused native child; inspect subagents first.",
    );
  }
  if (
    controller.controlScope !== "children" ||
    ensureSubagentControllerOwnsRun({ cfg, controller, entry })
  ) {
    throw new Error("Task resume is limited to children controlled by the calling session.");
  }
  if (entry.expectsCompletionMessage === false) {
    throw new Error("Task resume requires a child with task-owned completion.");
  }
  return entry;
}

/** Captures the exact paused generation after ordinary session visibility checks. */
export function bindParentSubagentResume(params: {
  cfg: OpenClawConfig;
  caller: TrustedAgentToolCaller;
  childSessionKey: string;
  childSessionId: string;
}): TrustedSubagentResume {
  if (!params.childSessionId) {
    throw new Error("Task resume requires an existing child session.");
  }
  const entry = requirePausedChild(params.cfg, params.caller, params.childSessionKey);
  return Object.freeze({
    caller: params.caller,
    childSessionKey: params.childSessionKey,
    childSessionId: params.childSessionId,
    previousRunId: entry.runId,
    taskRunId: entry.taskRunId ?? entry.runId,
    generation: entry.generation,
    createdAt: entry.createdAt,
  });
}

/** Revalidates caller ownership and the exact paused generation at admission. */
export function assertParentSubagentResumeCurrent(params: {
  cfg: OpenClawConfig;
  resume: TrustedSubagentResume;
  sessionKey: string | undefined;
  sessionId: string;
}): SubagentRunRecord {
  const { resume } = params;
  const entry = resume.caller
    ? requirePausedChild(params.cfg, resume.caller, resume.childSessionKey)
    : requireCallbackPausedChild(resume);
  if (
    params.sessionKey !== resume.childSessionKey ||
    params.sessionId !== resume.childSessionId ||
    entry.runId !== resume.previousRunId ||
    (entry.taskRunId ?? entry.runId) !== resume.taskRunId ||
    entry.generation !== resume.generation ||
    entry.createdAt !== resume.createdAt ||
    (entry.execution.transcriptTarget?.sessionId !== undefined &&
      entry.execution.transcriptTarget.sessionId !== resume.childSessionId)
  ) {
    throw new Error("Paused task or child session changed before resume; inspect subagents again.");
  }
  return entry;
}

/** Fences queued execution after the paused task transfers away from its parent caller. */
export function assertParentSubagentResumeSuccessorCurrent(
  resume: TrustedSubagentResume,
  runId: string,
): void {
  const current = getLatestLiveSubagentRunByChildSessionKey(resume.childSessionKey);
  if (
    !current ||
    current.runId !== runId ||
    current.taskRunId !== resume.taskRunId ||
    current.pauseReason ||
    current.killIntent ||
    current.killReconciliation ||
    typeof current.execution.endedAt === "number"
  ) {
    throw new Error("Resumed task no longer owns this execution.");
  }
}

/** Loads the existing replacement owner before admission's final synchronous transfer. */
export async function prepareParentSubagentResume(params: {
  cfg: OpenClawConfig;
  resume: TrustedSubagentResume;
  sessionKey: string | undefined;
  getSessionId: () => string;
  runId: string;
  task: string;
  assertAdmissionCurrent: () => void;
  gatewayContextResolver?: GatewayContextResolver;
}): Promise<() => string> {
  const runtime = await import("../agents/subagents/registry/subagent-registry.js");
  return () => {
    params.assertAdmissionCurrent();
    const expected = assertParentSubagentResumeCurrent({
      ...params,
      sessionId: params.getSessionId(),
    });
    // No await separates revalidation from the registry's atomic task/flow replacement.
    const adopted = runtime.adoptPausedSubagentRunForFollowUp({
      childSessionKey: params.resume.childSessionKey,
      runId: params.runId,
      task: params.task,
      expected,
      gatewayContextResolver: params.gatewayContextResolver,
    });
    if (!adopted) {
      throw new Error("Paused task replacement was rejected; no continuation was started.");
    }
    assertParentSubagentResumeSuccessorCurrent(params.resume, params.runId);
    return params.resume.taskRunId;
  };
}

/** A queue-owned capability may continue only the captured native child generation. */
function requireCallbackPausedChild(resume: TrustedSubagentResume): SubagentRunRecord {
  if (!resume.assertCallbackCurrent) {
    throw new Error("Task resume requires host-owned authority.");
  }
  resume.assertCallbackCurrent();
  const entry = getLatestLiveSubagentRunByChildSessionKey(resume.childSessionKey);
  if (
    !entry ||
    entry.pauseReason !== "sessions_yield" ||
    typeof entry.execution.endedAt !== "number" ||
    entry.collect ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.terminalOwner ||
    entry.suppressAnnounceReason ||
    entry.cleanupCompletedAt !== undefined ||
    entry.execution.suppressSessionEffects ||
    entry.expectsCompletionMessage === false
  ) {
    throw new Error("Callback requires the original paused native child.");
  }
  return entry;
}
