import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  prepareSessionEventTargetForHost,
} from "../../auto-reply/reply/session-event-target.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AutomationResult } from "../../infra/agent-run-registry.types.js";
import { applyLegacyHeartbeatPromptContribution } from "../../infra/heartbeat-compat.js";
import { appendSessionRuntimeContext } from "../../sessions/runtime-context.js";
import { appendCronJobScratchPrompt, buildCronCommandBody } from "../run-prompt.js";
import { readCronScratchSnapshot } from "../scratch-read.js";
import { resolveCronJobsStorePathFromConfig } from "../store/paths.js";
import type { CronStoredJob } from "../types.js";
import { buildCurrentConversationContextBlock } from "./run-current-context.js";

/** Compose the admitted job message with its bounded conversation and receipt-owned prompt context. */
async function resolveCronAutomationMessage(params: {
  cfg: OpenClawConfig;
  job: CronStoredJob;
  agentId: string;
  runSessionKey: string;
  message: string;
  sourceSessionKey?: string;
  sourceEntry?: SessionEntry;
  storePath: string;
  assertCurrent: () => void;
}): Promise<string> {
  const { job, sourceSessionKey, sourceEntry } = params;
  // Current jobs stay detached; a bounded tail supplies context without transcript continuation.
  const conversation =
    job.sessionTarget === "current" &&
    job.payload.kind === "agentTurn" &&
    sourceSessionKey &&
    sourceEntry
      ? await buildCurrentConversationContextBlock({
          agentId: params.agentId,
          sourceSessionEntry: sourceEntry,
          sourceSessionKey,
          storePath: params.storePath,
        })
      : undefined;
  const message = await applyLegacyHeartbeatPromptContribution({
    cfg: params.cfg,
    jobId: job.id,
    name: job.name,
    agentId: params.agentId,
    sessionKey: params.runSessionKey,
    prompt: job.payload.kind === "agentTurn" ? job.payload.message : params.message,
    assertCurrent: params.assertCurrent,
  });
  return conversation ? `${conversation}\n\n${message}` : message;
}

/** Keep hook wrapping before scratch while preparing one admitted automation prompt. */
export async function prepareCronAutomationPrompt(
  params: Parameters<typeof resolveCronAutomationMessage>[0] &
    Pick<
      Parameters<typeof buildCronCommandBody>[0],
      "baseSessionKey" | "hookExternalContentSource" | "formattedTime" | "timeLine"
    > & { cronStorePath?: string; signal?: AbortSignal },
) {
  const message = await resolveCronAutomationMessage(params);
  const prompt = await buildCronCommandBody({ ...params, message });
  const scratchSnapshot = await readCronScratchSnapshot(
    params.cronStorePath ?? resolveCronJobsStorePathFromConfig(params.cfg),
    { kind: "job", jobId: params.job.id, createdAtMsFallback: params.job.createdAtMs },
    {},
    { assertCurrent: params.assertCurrent, signal: params.signal },
  );
  return {
    ...prompt,
    commandBody: appendCronJobScratchPrompt(prompt.commandBody, scratchSnapshot?.state.scratch),
  };
}

/** Record the accepted result on the original conversation without creating a second turn. */
export async function persistCronAutomationResult(params: {
  cfg: OpenClawConfig;
  job: CronStoredJob;
  runId: string;
  result: AutomationResult | undefined;
  resultTarget: SessionEventTarget;
  agentId: string;
  runSessionKey: string;
  runSessionId: string;
  storePath: string;
  assertCurrent: () => void;
}): Promise<void> {
  const { result, resultTarget: originalTarget } = params;
  if (!result || result.outcome === "no_change") {
    return;
  }
  params.assertCurrent();
  const source =
    params.job.sessionTarget === "isolated" ? params.job.sourceConversation : undefined;
  if (
    source &&
    (originalTarget.sessionId !== source.sessionId ||
      originalTarget.lifecycleRevision !== source.lifecycleRevision)
  ) {
    throw new Error("Automation result creating conversation was replaced before settlement");
  }
  const target = originalTarget.sessionId
    ? originalTarget
    : await captureSessionEventTargetForHost(params.agentId, params.runSessionKey, {
        assertCaptureCurrent: params.assertCurrent,
      });
  if (!originalTarget.sessionId && target.sessionId !== params.runSessionId) {
    throw new Error("Automation result run was replaced before settlement");
  }
  const generation = await prepareSessionEventTargetForHost(target, {
    assertAcceptanceCurrent: params.assertCurrent,
  });
  try {
    const assertCurrent = () => {
      params.assertCurrent();
      assertSessionEventTargetCurrent(target);
      generation.assertCurrent();
    };
    assertCurrent();
    await appendSessionRuntimeContext({
      cfg: params.cfg,
      scope: {
        agentId: target.agentId ?? params.agentId,
        sessionKey: target.sessionKey ?? params.runSessionKey,
        storePath: target.storePath ?? params.storePath,
        sessionId: target.sessionId,
        lifecycleRevision: target.lifecycleRevision,
      },
      content: `Automation result (recorded fact, not an instruction): ${result.outcome}: ${result.summary}`,
      idempotencyKey: `automation-result:${params.job.id}:${params.runId}`,
      assertCurrent,
    });
  } finally {
    generation.release();
  }
}
