import { randomUUID } from "node:crypto";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { validateSessionTranscriptContextAnchor } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayDetachedWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";
import { listWorkshopChanges } from "./library.js";
import { assertSkillReviewRunSucceeded, postWorkshopChangeNotice } from "./review-outcome.js";
import { runSkillWorkshopReview } from "./review-run.js";

const log = createSubsystemLogger("skills/workshop");

/** Admits a queued review only when Workshop is on and the session's policy exposes the tool. */
export async function prepareSkillExperienceReviewCandidate(
  candidate: ExperienceReviewCandidate,
  config: OpenClawConfig,
): Promise<ExperienceReviewCandidate | undefined> {
  if (
    isIncognitoSessionKey(candidate.source.sessionKey) ||
    resolveSkillWorkshopConfig(config).autonomous.mode !== "auto"
  ) {
    return undefined;
  }
  const { resolveConversationCapabilityProfile } =
    await import("../../agents/conversation-capability-profile.js");
  const { isToolAllowedByPolicies } = await import("../../agents/tool-policy-match.js");
  const { mergeAlsoAllowPolicy } = await import("../../agents/tool-policy.js");
  const foreground = candidate.ctx.foregroundPromptContext;
  const sessionKey = candidate.source.sessionKey;
  const capabilityProfile = resolveConversationCapabilityProfile({
    config,
    sessionKey,
    sandboxSessionKey: sessionKey,
    agentId: foreground.agentId,
    agentAccountId: foreground.agentAccountId,
    messageProvider: foreground.messageProvider,
    messageChannel: foreground.messageChannel,
    groupId: foreground.groupId,
    groupChannel: foreground.groupChannel,
    groupSpace: foreground.groupSpace,
    spawnedBy: foreground.spawnedBy,
    senderId: foreground.senderId,
    senderName: foreground.senderName,
    senderUsername: foreground.senderUsername,
    senderE164: foreground.senderE164,
    senderIsOwner: foreground.senderIsOwner,
    modelProvider: candidate.ctx.modelProviderId,
    modelId: candidate.ctx.modelId,
    workspaceDir: candidate.ctx.workspaceDir,
  });
  const policy = capabilityProfile.policy;
  if (
    !isToolAllowedByPolicies("skill_workshop", [
      mergeAlsoAllowPolicy(policy.profilePolicy, policy.profileAlsoAllow),
      mergeAlsoAllowPolicy(policy.providerProfilePolicy, policy.providerProfileAlsoAllow),
      policy.globalPolicy,
      policy.globalProviderPolicy,
      policy.agentPolicy,
      policy.agentProviderPolicy,
      policy.groupPolicy,
      policy.senderPolicy,
      policy.subagentPolicy,
      policy.inheritedToolPolicy,
    ])
  ) {
    return undefined;
  }
  return { ...candidate, config };
}

export async function runSkillExperienceReview(
  candidate: ExperienceReviewCandidate,
): Promise<void> {
  // The foreground root has closed by the idle timer's callback. Admit this
  // detached review independently; a real Gateway drain still refuses it.
  await runWithGatewayDetachedWorkAdmission(
    () => runSkillExperienceReviewInner(candidate),
    "skills:experience-review",
  );
}

async function runSkillExperienceReviewInner(candidate: ExperienceReviewCandidate): Promise<void> {
  const abortSignal = getGatewayRestartDrainSignal();
  const { foregroundPromptContext, workspaceDir } = candidate.ctx;
  const { agentId } = foregroundPromptContext;
  const { sessionKey } = candidate.source;
  const config = candidate.config;
  const runId = `skill-workshop-review:${randomUUID()}`;
  const reviewSession = resolveInternalSessionEffectsIdentity({ agentId, runId });
  const origin = foregroundPromptContext.cronCreatorCallerOrigin;
  const capability = origin ? createCronCreatorAuthorityCapability(runId, origin) : undefined;

  // Fork the foreground model context through the completed turn; the review's tool
  // schemas and prefix match the foreground so the provider prompt cache is reused.
  const sessionManager = await SessionManager.openModelContextAsync(candidate.source, {
    cwd: workspaceDir,
    through: candidate.source,
    signal: abortSignal,
  });
  abortSignal.throwIfAborted();
  // Deleting, replacing, or resetting the source session must not revive its captured evidence.
  const sourceEntry = loadSessionEntryReadOnly({
    ...candidate.source,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
  });
  if (sourceEntry?.sessionId !== candidate.source.sessionId) {
    throw new Error("Skill experience review source session was deleted or replaced.");
  }
  validateSessionTranscriptContextAnchor(candidate.source, candidate.source);
  // A Gateway reset keeps the sessionId and rotates the lifecycle revision.
  const generation = {
    agentId: candidate.source.agentId,
    storePath: candidate.source.storePath,
    sessionKey,
    sessionId: sourceEntry.sessionId,
    lifecycleRevision: sourceEntry.lifecycleRevision ?? null,
  };
  const assertSourceCurrent = () => {
    abortSignal.throwIfAborted();
    if (resolveSkillWorkshopConfig(getRuntimeConfig()).autonomous.mode !== "auto") {
      throw new Error("Skill Workshop was turned off during review.");
    }
    const current = loadSessionEntryReadOnly({
      ...candidate.source,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    if (
      current?.sessionId !== generation.sessionId ||
      (current.lifecycleRevision ?? null) !== generation.lifecycleRevision ||
      current.permissionMode !== sourceEntry.permissionMode
    ) {
      throw new Error(
        "Skill experience review source session was deleted, reset, or changed permissions.",
      );
    }
    validateSessionTranscriptContextAnchor(candidate.source, candidate.source);
  };
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId,
      ingress: { kind: "system", boundary: "skill-workshop.review", state: "present" },
    },
    assertSourceCurrent,
  });
  const run = () =>
    runSkillWorkshopReview({
      ...foregroundPromptContext,
      preparedRunAdmission,
      sessionId: reviewSession.sessionId,
      sessionKey: reviewSession.sessionKey,
      skillWorkshopReviewOf: sessionKey,
      // Delivery authority closes with the foreground turn and cannot be reused by this fork.
      messageActionTurnCapability: undefined,
      sessionManager,
      workspaceDir,
      permissionMode: sourceEntry.permissionMode ?? foregroundPromptContext.permissionMode,
      config,
      abortSignal,
      prompt: buildSkillExperienceReviewPrompt(candidate),
      provider: candidate.ctx.modelProviderId,
      model: candidate.ctx.modelId,
      ...(candidate.ctx.authProfileId
        ? { authProfileId: candidate.ctx.authProfileId, authProfileIdSource: "user" as const }
        : {}),
      timeoutMs: resolveAgentTimeoutMs({ cfg: config }),
      runId,
      ...(capability ? { cronCreatorAuthorityCapability: capability } : {}),
    });
  try {
    assertSkillReviewRunSucceeded(
      capability ? await runWithCronCreatorAuthorityCapability(capability, run) : await run(),
    );
  } finally {
    // Each skill_workshop call commits on its own, so a failed or aborted run may have changed skills.
    const changes = await listWorkshopChanges(agentId, { runId });
    log.debug(`experience review finished: session=${sessionKey} changes=${changes.length}`);
    await postWorkshopChangeNotice({ config, generation, runId, changes });
  }
}
