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
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../../config/sessions/session-transcript-read-source.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
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
import { workshopReviewRunId } from "./review-undo.js";

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
  const { prepareConversationCapabilityProfile } =
    await import("../../agents/conversation-capability-profile.js");
  const { isToolAllowedByPolicies } = await import("../../agents/tool-policy-match.js");
  const { mergeAlsoAllowPolicy } = await import("../../agents/tool-policy.js");
  const foreground = candidate.ctx.foregroundPromptContext;
  const sessionKey = candidate.source.sessionKey;
  const capabilityProfile = await prepareConversationCapabilityProfile({
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
  const runId = workshopReviewRunId(randomUUID());
  const reviewSession = resolveInternalSessionEffectsIdentity({ agentId, runId });
  const origin = foregroundPromptContext.cronCreatorCallerOrigin;
  const capability = origin ? createCronCreatorAuthorityCapability(runId, origin) : undefined;
  const writeScopes = [sessionKey, sqliteSessionIdWriteScope(candidate.source.sessionId)];
  const readWriteToken = () =>
    readSqliteDatabaseScopedWriteTokenForPath(candidate.source.storePath, writeScopes);
  let validatedWriteToken: string | undefined;
  using sourceLifetime: Disposable & {
    entry?: ReturnType<typeof retainPreparedSessionEntryPredicate>;
  } = {
    [Symbol.dispose]() {
      this.entry?.release();
    },
  };

  // Read only a bounded suffix through the completed turn. The review does not
  // need to repay the entire conversation's token budget to learn one procedure.
  const prepare = async (
    source: typeof candidate.source,
    assertPhysicalCurrent: () => void,
    assertPreparationCurrent: () => void,
    databaseIdentity?: string,
  ) => {
    const sessionManager = await SessionManager.openModelContextAsync(source, {
      cwd: workspaceDir,
      through: candidate.source,
      limits: { maxBytes: 32_768, maxEvents: 64, toolResultOverflow: "omit" },
      signal: abortSignal,
    });
    assertPreparationCurrent();
    // Deleting, replacing, or resetting the source session must not revive its captured evidence.
    let sourceEntry:
      | Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "permissionMode">
      | undefined;
    await readSessionTranscriptAnchorsAsync(
      source,
      {
        entryIds: [],
        contextAuthority: true,
        contextValidation: { through: candidate.source },
      },
      abortSignal,
      (facts) => {
        assertPreparationCurrent();
        const current = facts.contextAuthority?.entry;
        if (current?.sessionId !== candidate.source.sessionId) {
          throw new Error("Skill experience review source session was deleted or replaced.");
        }
        if (facts.contextValidated) {
          sourceEntry = current;
          if (databaseIdentity) {
            sourceLifetime.entry = retainPreparedSessionEntryPredicate({
              databaseIdentity,
              sessionKey,
              entry: current,
              matches: (_before, after) =>
                after?.sessionId === current.sessionId &&
                (after.lifecycleRevision ?? null) === (current.lifecycleRevision ?? null) &&
                after.permissionMode === current.permissionMode,
            });
          }
          validatedWriteToken = readWriteToken();
        }
      },
    );
    if (!sourceEntry) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
    return { source, sourceEntry, sessionManager, assertPhysicalCurrent };
  };
  const { source, sourceEntry, sessionManager, assertPhysicalCurrent } =
    await withSessionTranscriptReadSource(
      candidate.source,
      ({ scope, expectedIdentity, assertCurrent }) => {
        const assertSourceIdentity = () => {
          abortSignal.throwIfAborted();
          if (expectedIdentity) {
            assertExistingDatabaseIdentity(
              scope.storePath,
              expectedIdentity.key,
              expectedIdentity.birthtime,
            );
          }
        };
        return prepare(
          { ...candidate.source, ...scope },
          assertSourceIdentity,
          assertCurrent,
          expectedIdentity?.key,
        );
      },
      abortSignal,
    );
  // A Gateway reset keeps the sessionId and rotates the lifecycle revision.
  const generation = {
    agentId: candidate.source.agentId,
    storePath: candidate.source.storePath,
    sessionKey,
    sessionId: sourceEntry.sessionId,
    lifecycleRevision: sourceEntry.lifecycleRevision ?? null,
  };
  const assertScopeCurrent = () => {
    assertPhysicalCurrent();
    if (sourceLifetime.entry && !sourceLifetime.entry.isCurrent()) {
      throw new SessionTranscriptReadFenceError("Session review authority changed");
    }
    if (resolveSkillWorkshopConfig(getRuntimeConfig()).autonomous.mode !== "auto") {
      throw new Error("Skill Workshop was turned off during review.");
    }
  };
  const assertReceiptCurrent = (token: string | undefined) => {
    assertScopeCurrent();
    if (token === undefined || readWriteToken() !== token) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
  };
  const prepareSource = async (): Promise<PreparedSessionSourceAuthority> => {
    assertScopeCurrent();
    if (validatedWriteToken === undefined || readWriteToken() !== validatedWriteToken) {
      // The reader retains writer admission through this callback. Reuse its
      // authority until an owning session or transcript writer publishes a change.
      validatedWriteToken = undefined;
      await readSessionTranscriptAnchorsAsync(
        source,
        {
          entryIds: [],
          contextValidation: { through: candidate.source, expectedAuthority: sourceEntry },
        },
        abortSignal,
        (facts) => {
          if (facts.contextValidated) {
            validatedWriteToken = readWriteToken();
          }
        },
      );
    }
    const token = validatedWriteToken;
    const assertCurrent = () => assertReceiptCurrent(token);
    assertCurrent();
    return { assertCurrent, checks: [] };
  };
  const assertSourceCurrent = composeSessionSourceAssertion([
    Object.assign(
      () => {
        // Model liveness follows admitted entry facts; each effect separately
        // revalidates the completed-turn anchor and retains its exact write receipt.
        assertScopeCurrent();
        if (!sourceLifetime.entry) {
          assertReceiptCurrent(validatedWriteToken);
        }
      },
      {
        assertScopeCurrent,
        prepareSessionSource: prepareSource,
        prepareSessionSourceScope: prepareSource,
      },
    ),
  ]);
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
      // This system review inherits prompt context, not the foreground turn's trigger.
      trigger: undefined,
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
    await postWorkshopChangeNotice({ config, generation, runId, changes });
  }
}
