import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Check } from "typebox/value";
import { SKILL_LIBRARY_MAX_SELECTIONS } from "../../packages/gateway-protocol/src/schema/skill-library.js";
import { UserChannelIdentitySchema } from "../../packages/gateway-protocol/src/schema/users.js";
import { isChannelIngressReadCommand } from "../channels/message/ingress-queue-read-contract.js";
import { isWorkspaceJournalReadCommand } from "../gateway/worker-environments/placement-workspace-journal.types.js";
import { isPluginBlobReadCommand } from "../plugin-state/plugin-blob-worker-contract.js";
import { isTuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isReadRequest(input: unknown): input is OpenClawStateReadRequest {
  if (!isRecord(input) || !isRecord(input.context) || !isRecord(input.command)) {
    return false;
  }
  const { environment } = input.context;
  return (
    typeof input.databasePath === "string" &&
    typeof input.location === "string" &&
    typeof input.checkFreshAdmission === "boolean" &&
    (input.expectedIdentity === undefined || typeof input.expectedIdentity === "string") &&
    (input.snapshotRoot === undefined || typeof input.snapshotRoot === "string") &&
    (input.context.existingSchemaPath === undefined ||
      typeof input.context.existingSchemaPath === "string") &&
    isRecord(environment) &&
    typeof environment.OPENCLAW_STATE_DIR === "string" &&
    (environment.OPENCLAW_SUPERVISOR_MODE === undefined ||
      environment.OPENCLAW_SUPERVISOR_MODE === "external") &&
    ((input.command.type === "deliveryQueue.outbound" &&
      (input.command.id === undefined || typeof input.command.id === "string") &&
      (input.command.mode === "pending" || input.command.mode === "unfinished")) ||
      (input.command.type === "pairing.allowFrom" &&
        isRecord(input.command.input) &&
        typeof input.command.input.channel === "string" &&
        typeof input.command.input.accountId === "string") ||
      (input.command.type === "sessionState.ambientTargets" &&
        isRecord(input.command.input) &&
        typeof input.command.input.watcherSessionKey === "string") ||
      (input.command.type === "generatedHtmlProvenance.read" &&
        typeof input.command.input === "string") ||
      (input.command.type === "generatedHtmlProvenance.list" &&
        input.command.input === undefined) ||
      (input.command.type === "mentions.snapshot" &&
        typeof input.command.input === "number" &&
        Number.isSafeInteger(input.command.input) &&
        input.command.input >= -1) ||
      (input.command.type === "sessionState.versions" &&
        Array.isArray(input.command.input) &&
        input.command.input.every(
          (ref) =>
            isRecord(ref) && typeof ref.sessionKey === "string" && typeof ref.agentId === "string",
        )) ||
      (input.command.type === "sessionState.events" &&
        isRecord(input.command.input) &&
        typeof input.command.input.sessionKey === "string" &&
        typeof input.command.input.agentId === "string" &&
        typeof input.command.input.afterSequence === "number" &&
        typeof input.command.input.limit === "number") ||
      (input.command.type === "diagnostic.latest" &&
        isRecord(input.command.input) &&
        typeof input.command.input.scope === "string" &&
        Number.isSafeInteger(input.command.input.limit) &&
        (input.command.input.beforeSequence === undefined ||
          Number.isSafeInteger(input.command.input.beforeSequence))) ||
      (input.command.type === "secrets.execEnvironment" &&
        isRecord(input.command.input) &&
        isStringArray(input.command.input.excludeNames)) ||
      (input.command.type === "secrets.value" &&
        isRecord(input.command.input) &&
        typeof input.command.input.name === "string") ||
      (input.command.type === "secrets.metadata" &&
        isRecord(input.command.input) &&
        isRecord(input.command.input.scope) &&
        input.command.input.scope.kind === "team" &&
        (input.command.input.includeDeleted === undefined ||
          typeof input.command.input.includeDeleted === "boolean") &&
        (input.command.input.redactedOnly === undefined ||
          typeof input.command.input.redactedOnly === "boolean")) ||
      input.command.type === "acpSessions.list" ||
      input.command.type === "backup.runs" ||
      ((input.command.type === "restartSentinel.current" ||
        input.command.type === "restartSentinel.snapshot" ||
        input.command.type === "restartSentinel.installReceipt") &&
        "input" in input.command &&
        input.command.input === undefined) ||
      (input.command.type === "claws.packageOwnership" &&
        typeof input.command.includeInstalls === "boolean" &&
        (input.command.agentId === undefined || typeof input.command.agentId === "string")) ||
      (input.command.type === "acpSessions.metadata" &&
        Array.isArray(input.command.entries) &&
        input.command.entries.length <= 64 &&
        input.command.entries.every(
          (entry) =>
            isRecord(entry) &&
            Array.isArray(entry.keys) &&
            entry.keys.length <= 3 &&
            entry.keys.every((key) => typeof key === "string") &&
            (entry.entry === undefined ||
              (isRecord(entry.entry) &&
                (entry.entry.lifecycleRevision === undefined ||
                  typeof entry.entry.lifecycleRevision === "string") &&
                (entry.entry.sessionId === undefined ||
                  typeof entry.entry.sessionId === "string") &&
                (entry.entry.sessionStartedAt === undefined ||
                  typeof entry.entry.sessionStartedAt === "number"))),
        )) ||
      (input.command.type === "mcpOAuth.statuses" && isStringArray(input.command.input)) ||
      ((input.command.type === "mcpOAuth.readOnly" ||
        input.command.type === "mcpOAuth.keys" ||
        input.command.type === "mcpOAuth.pending" ||
        input.command.type === "mcpOAuth.countPrincipals") &&
        typeof input.command.input === "string") ||
      (input.command.type === "capture.readOnlyEvents" &&
        typeof input.command.sessionId === "string" &&
        (input.command.limit === undefined || typeof input.command.limit === "number")) ||
      (input.command.type === "capture.readOnlyBlob" && typeof input.command.blobId === "string") ||
      isPluginBlobReadCommand(input.command) ||
      isChannelIngressReadCommand(input.command) ||
      (input.command.type === "conversationBindings.inspect" &&
        isRecord(input.command.conversation) &&
        typeof input.command.conversation.channel === "string" &&
        typeof input.command.conversation.accountId === "string" &&
        typeof input.command.conversation.conversationId === "string" &&
        (input.command.conversation.parentConversationId === undefined ||
          typeof input.command.conversation.parentConversationId === "string")) ||
      (input.command.type === "cron.activeReceiptOwners" &&
        typeof input.command.agentId === "string") ||
      (input.command.type === "cron.scratch" &&
        typeof input.command.storeKey === "string" &&
        isRecord(input.command.selector) &&
        ((input.command.selector.kind === "job" &&
          typeof input.command.selector.jobId === "string" &&
          typeof input.command.selector.createdAtMsFallback === "number" &&
          Number.isFinite(input.command.selector.createdAtMsFallback)) ||
          (input.command.selector.kind === "heartbeat" &&
            typeof input.command.selector.agentId === "string"))) ||
      (input.command.type === "cron.jobNames" &&
        (input.command.storePath === undefined || typeof input.command.storePath === "string") &&
        isStringArray(input.command.jobIds)) ||
      (input.command.type === "cron.quarantine" && typeof input.command.storeKey === "string") ||
      (input.command.type === "cron.currentReceipt" &&
        isRecord(input.command.handle) &&
        typeof input.command.handle.receiptId === "string" &&
        typeof input.command.handle.storeKey === "string" &&
        typeof input.command.handle.jobId === "string" &&
        typeof input.command.handle.agentId === "string" &&
        typeof input.command.handle.ownerPid === "number" &&
        Number.isFinite(input.command.handle.ownerPid) &&
        (input.command.handle.ownerStartTime === null ||
          (typeof input.command.handle.ownerStartTime === "number" &&
            Number.isFinite(input.command.handle.ownerStartTime))) &&
        typeof input.command.includeJob === "boolean" &&
        typeof input.command.includeAvailability === "boolean") ||
      (input.command.type === "cron.observeRunRecovery" &&
        typeof input.command.storeKey === "string" &&
        Array.isArray(input.command.proposals) &&
        input.command.proposals.every(
          (proposal: unknown) =>
            isRecord(proposal) &&
            typeof proposal.jobId === "string" &&
            (proposal.queuedAtMs === undefined || typeof proposal.queuedAtMs === "number") &&
            (proposal.runningAtMs === undefined || typeof proposal.runningAtMs === "number"),
        )) ||
      (input.command.type === "devicePairing.list" && typeof input.command.nowMs === "number") ||
      (input.command.type === "devicePairing.lookup" &&
        typeof input.command.deviceId === "string") ||
      (input.command.type === "devicePairing.pending" &&
        typeof input.command.requestId === "string" &&
        typeof input.command.nowMs === "number") ||
      (input.command.type === "devicePairing.bootstrapContext" &&
        isRecord(input.command.input) &&
        typeof input.command.input.token === "string" &&
        typeof input.command.input.deviceId === "string" &&
        typeof input.command.input.publicKey === "string" &&
        typeof input.command.input.nowMs === "number") ||
      input.command.type === "admit" ||
      input.command.type === "doctor.gatewayOwnerLease.read" ||
      input.command.type === "subagents.sessionList" ||
      (input.command.type === "subagents.forChildSession" &&
        typeof input.command.childSessionKey === "string") ||
      (input.command.type === "subagents.runs" &&
        isRecord(input.command.scope) &&
        (input.command.scope.kind === "all" ||
          input.command.scope.kind === "maintenance" ||
          (input.command.scope.kind === "session" &&
            typeof input.command.scope.sessionKey === "string") ||
          (input.command.scope.kind === "descendants" &&
            isStringArray(input.command.scope.sessionKeys) &&
            Array.isArray(input.command.scope.liveTopology) &&
            input.command.scope.liveTopology.every(
              (link: unknown) =>
                isRecord(link) &&
                typeof link.childSessionKey === "string" &&
                typeof link.requesterSessionKey === "string",
            )) ||
          (input.command.scope.kind === "ids" && isStringArray(input.command.scope.runIds)))) ||
      input.command.type === "exec-approvals.read" ||
      (input.command.type === "skillLibrary.read" &&
        isRecord(input.command.input) &&
        typeof input.command.input.kind === "string" &&
        [
          "presentation",
          "list",
          "read",
          "seed",
          "change",
          "pins",
          "profile",
          "entry",
          "upload",
        ].includes(input.command.input.kind) &&
        isRecord(input.command.input.authority) &&
        isStringArray(input.command.input.authority.scopes) &&
        isRecord(input.command.input.authority.config)) ||
      ((input.command.type === "skills.library.descriptions" ||
        input.command.type === "skills.library.manifests") &&
        Array.isArray(input.command.input) &&
        input.command.input.length <= SKILL_LIBRARY_MAX_SELECTIONS &&
        input.command.input.every(
          (pin) =>
            isRecord(pin) && typeof pin.skillId === "string" && typeof pin.revision === "string",
        )) ||
      input.command.type === "agentDatabaseRegistry.read" ||
      (input.command.type === "agentDatabaseDeletion.snapshot" &&
        (input.command.purpose === "runtime" || input.command.purpose === "maintenance")) ||
      ((input.command.type === "agentDeletionJournal.status" ||
        input.command.type === "agentDeletionJournal.authority") &&
        typeof input.command.agentId === "string") ||
      input.command.type === "sessionGroups.snapshot" ||
      (input.command.type === "sessionGroups.members" && isRecord(input.command.cfg)) ||
      (input.command.type === "workerEnvironments.snapshot" &&
        (input.command.ids === undefined || isStringArray(input.command.ids))) ||
      (input.command.type === "workerEnvironments.pruneCandidates" &&
        isRecord(input.command.input) &&
        typeof input.command.input.nowMs === "number" &&
        (input.command.input.limit === undefined ||
          typeof input.command.input.limit === "number") &&
        (input.command.input.cursor === undefined ||
          (isRecord(input.command.input.cursor) &&
            typeof input.command.input.cursor.changedAtMs === "number" &&
            typeof input.command.input.cursor.environmentId === "string"))) ||
      input.command.type === "userProfiles.catalog" ||
      (input.command.type === "userModelAccounts.links" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userPreferences.values" &&
        typeof input.command.key === "string" &&
        isStringArray(input.command.profileIds)) ||
      input.command.type === "config.snapshot.read" ||
      (input.command.type === "githubPublication.lifecycle" &&
        (input.command.publicationKind === "shared" ||
          input.command.publicationKind === "personal") &&
        typeof input.command.requestId === "string") ||
      ((input.command.type === "githubPublication.request" ||
        input.command.type === "githubRepository.request") &&
        typeof input.command.requestId === "string") ||
      ((input.command.type === "githubPublication.knownPullRequestUrls" ||
        input.command.type === "githubRepository.knownPullRequestUrls") &&
        isRecord(input.command.input)) ||
      ((input.command.type === "userProfiles.reconcile" ||
        input.command.type === "userProfiles.avatar.inspect") &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.avatar.read" &&
        typeof input.command.profileId === "string" &&
        isRecord(input.command.expected) &&
        typeof input.command.expected.canonicalProfileId === "string" &&
        typeof input.command.expected.sha256 === "string" &&
        typeof input.command.expected.mime === "string") ||
      (input.command.type === "userProfiles.channelIdentity.list" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.authority.resolve" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.githubIdentity.cached" &&
        typeof input.command.accountId === "number" &&
        typeof input.command.email === "string") ||
      (input.command.type === "userProfiles.githubAttribution.resolve" &&
        isStringArray(input.command.profileIds)) ||
      (input.command.type === "userProfiles.channelIdentity.resolve" &&
        (Check(UserChannelIdentitySchema, input.command.identity) ||
          (isRecord(input.command.identity) &&
            typeof input.command.identity.authorizationId === "string" &&
            isRecord(input.command.identity.policy)))) ||
      (input.command.type === "userProfiles.email.resolve" &&
        typeof input.command.email === "string") ||
      (input.command.type === "audit.run.inspect" &&
        isRecord(input.command.input) &&
        typeof input.command.input.now === "number" &&
        (typeof input.command.input.runId === "string" ||
          typeof input.command.input.executionId === "string")) ||
      (input.command.type === "githubPublication.sharedObservation" &&
        isRecord(input.command.input) &&
        (input.command.input.kind === "repository" || input.command.input.kind === "worktree") &&
        isRecord(input.command.input.session) &&
        typeof input.command.input.session.agentId === "string" &&
        typeof input.command.input.session.sessionKey === "string" &&
        typeof input.command.input.session.sessionId === "string" &&
        isRecord(input.command.input.selector) &&
        isRecord(input.command.input.entry)) ||
      (input.command.type === "sessionRepositoryWorkspaces.find" &&
        Array.isArray(input.command.owners) &&
        input.command.owners.every(
          (owner) =>
            isRecord(owner) &&
            typeof owner.agentId === "string" &&
            typeof owner.sessionKey === "string",
        )) ||
      (input.command.type === "workspace.snapshot" &&
        typeof input.command.workspaceDir === "string") ||
      (input.command.type === "updateRuns.get" && typeof input.command.runId === "string") ||
      input.command.type === "updateRuns.interruptedCandidate" ||
      input.command.type === "updateRuns.status" ||
      input.command.type === "updateRuns.historyStatus" ||
      (input.command.type === "updateRuns.reconciliationCandidate" &&
        typeof input.command.runId === "string") ||
      (input.command.type === "updateRuns.reconciliationCandidates" &&
        isRecord(input.command.input) &&
        (input.command.input.explicit === undefined ||
          typeof input.command.input.explicit === "boolean") &&
        (input.command.input.requireAllActive === undefined ||
          typeof input.command.input.requireAllActive === "boolean") &&
        (input.command.input.legacyOnly === undefined ||
          typeof input.command.input.legacyOnly === "boolean") &&
        (input.command.input.repairHistorySinceMs === undefined ||
          (typeof input.command.input.repairHistorySinceMs === "number" &&
            Number.isFinite(input.command.input.repairHistorySinceMs))) &&
        (input.command.input.runIds === undefined || isStringArray(input.command.input.runIds))) ||
      (input.command.type === "updateRuns.list" &&
        isRecord(input.command.input) &&
        (input.command.input.limit === undefined ||
          typeof input.command.input.limit === "number") &&
        (input.command.input.active === undefined ||
          typeof input.command.input.active === "boolean") &&
        (input.command.input.reason === undefined ||
          typeof input.command.input.reason === "string") &&
        (input.command.input.includeRunId === undefined ||
          typeof input.command.input.includeRunId === "string")) ||
      input.command.type === "fleet.list" ||
      ((input.command.type === "operatorApprovals.history" ||
        input.command.type === "operatorApprovals.listCronGrants") &&
        isRecord(input.command.input)) ||
      isTuiLastSessionReadCommand(input.command) ||
      input.command.type === "nodeHost.config" ||
      input.command.type === "tts.prefsPath" ||
      input.command.type === "operator.channelPolicy" ||
      input.command.type === "preparedPoolPresence.read" ||
      (input.command.type === "onboardingRecommendations.read" &&
        typeof input.command.configKey === "string") ||
      input.command.type === "sandboxRegistry.list" ||
      input.command.type === "sandboxRegistry.browsers" ||
      (input.command.type === "sandboxRegistry.get" &&
        typeof input.command.containerName === "string") ||
      (input.command.type === "sandboxRegistry.runtimeIds" &&
        typeof input.command.backendId === "string" &&
        typeof input.command.scopeKey === "string") ||
      (input.command.type === "fleet.get" && typeof input.command.tenantId === "string") ||
      input.command.type === "worktrees.cleanupState" ||
      (input.command.type === "workerPlacements.changeSnapshot" &&
        (input.command.profileIds === undefined || isStringArray(input.command.profileIds))) ||
      isWorkspaceJournalReadCommand(input.command) ||
      input.command.type === "workers.placementRecoveryCandidates" ||
      input.command.type === "workers.placementPreservation" ||
      (input.command.type === "workers.placementPendingResults" &&
        (input.command.sessionId === undefined || typeof input.command.sessionId === "string")) ||
      (input.command.type === "workers.placementProjection" &&
        isStringArray(input.command.sessionIds) &&
        Array.isArray(input.command.conflictBindings)))
  );
}
