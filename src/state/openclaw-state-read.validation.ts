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

function isAcpSessionReadInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.keys) &&
    value.keys.length <= 3 &&
    value.keys.every((key) => typeof key === "string") &&
    (value.entry === undefined ||
      (isRecord(value.entry) &&
        (value.entry.lifecycleRevision === undefined ||
          typeof value.entry.lifecycleRevision === "string") &&
        (value.entry.sessionId === undefined || typeof value.entry.sessionId === "string") &&
        (value.entry.sessionStartedAt === undefined ||
          typeof value.entry.sessionStartedAt === "number")))
  );
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
    (input.context.stateIntegrity === undefined ||
      (isRecord(input.context.stateIntegrity) &&
        isRecord(input.context.stateIntegrity.identity) &&
        typeof input.context.stateIntegrity.identity.key === "string" &&
        input.context.stateIntegrity.revision instanceof SharedArrayBuffer &&
        input.context.stateIntegrity.revision.byteLength === BigInt64Array.BYTES_PER_ELEMENT &&
        typeof input.context.stateIntegrity.epoch === "bigint" &&
        input.context.stateIntegrity.epoch >= 0n &&
        input.context.stateIntegrity.proof instanceof SharedArrayBuffer &&
        input.context.stateIntegrity.proof.byteLength === BigInt64Array.BYTES_PER_ELEMENT)) &&
    isRecord(environment) &&
    typeof environment.OPENCLAW_STATE_DIR === "string" &&
    (environment.OPENCLAW_SUPERVISOR_MODE === undefined ||
      environment.OPENCLAW_SUPERVISOR_MODE === "external") &&
    ((input.command.type === "meetingTranscripts.export" &&
      ((input.command.format === "library" &&
        typeof input.command.selector === "string" &&
        typeof input.command.includeNotes === "boolean") ||
        (input.command.format === "artifact" &&
          isRecord(input.command.session) &&
          typeof input.command.session.sessionId === "string" &&
          typeof input.command.session.startedAt === "string"))) ||
      (input.command.type === "deliveryQueue.outbound" &&
        (input.command.id === undefined || typeof input.command.id === "string") &&
        (input.command.mode === "pending" || input.command.mode === "unfinished")) ||
      (input.command.type === "pairing.allowFrom" &&
        isRecord(input.command.input) &&
        typeof input.command.input.channel === "string" &&
        typeof input.command.input.accountId === "string") ||
      (input.command.type === "gatewayBoot.breaker" &&
        typeof input.command.input === "number" &&
        Number.isSafeInteger(input.command.input)) ||
      ((input.command.type === "localWorkspace.get" ||
        input.command.type === "localWorkspace.exists") &&
        isRecord(input.command.input) &&
        typeof input.command.input.id === "string") ||
      (input.command.type === "sessionState.pendingNotices" && input.command.input === undefined) ||
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
      (input.command.type === "sessionUpstream.read" &&
        isRecord(input.command.input) &&
        typeof input.command.input.sessionKey === "string" &&
        typeof input.command.input.agentId === "string") ||
      (input.command.type === "diagnostic.latest" &&
        isRecord(input.command.input) &&
        typeof input.command.input.scope === "string" &&
        Number.isSafeInteger(input.command.input.limit) &&
        (input.command.input.beforeSequence === undefined ||
          Number.isSafeInteger(input.command.input.beforeSequence))) ||
      (input.command.type === "diagnostic.configAuditFacts" &&
        isRecord(input.command.input) &&
        typeof input.command.input.scope === "string" &&
        Number.isSafeInteger(input.command.input.lastSeenAuditSequence)) ||
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
      (input.command.type === "acpSessions.resume" &&
        (input.command.sessionKey === undefined || typeof input.command.sessionKey === "string") &&
        typeof input.command.agentId === "string" &&
        typeof input.command.resumeSessionId === "string" &&
        (input.command.backendId === undefined || typeof input.command.backendId === "string")) ||
      input.command.type === "acpSessions.list" ||
      input.command.type === "backup.runs" ||
      (input.command.type === "restartSentinel.reportReceipt" &&
        typeof input.command.input === "string") ||
      ((input.command.type === "restartSentinel.current" ||
        input.command.type === "restartSentinel.snapshot" ||
        input.command.type === "restartSentinel.installReceipt" ||
        input.command.type === "plugins.deferredMigrations.read" ||
        input.command.type === "legacySessionMigration.readLedger" ||
        input.command.type === "config.health.read") &&
        "input" in input.command &&
        input.command.input === undefined) ||
      (input.command.type === "agentRecovery.creationJournal" &&
        "input" in input.command &&
        isRecord(input.command.input) &&
        typeof input.command.input.agentId === "string") ||
      (input.command.type === "agentRecovery.holds" &&
        isRecord(input.command.input) &&
        typeof input.command.input.statePath === "string") ||
      (input.command.type === "claws.packageOwnership" &&
        typeof input.command.includeInstalls === "boolean" &&
        (input.command.agentId === undefined || typeof input.command.agentId === "string")) ||
      (input.command.type === "acpSessions.metadata" &&
        Array.isArray(input.command.entries) &&
        input.command.entries.length <= 64 &&
        input.command.entries.every(isAcpSessionReadInput)) ||
      (input.command.type === "sessionRows.sharedFacts" &&
        Array.isArray(input.command.entries) &&
        input.command.entries.length <= 64 &&
        input.command.entries.every(
          (entry) =>
            isRecord(entry) &&
            (entry.acp === undefined || isAcpSessionReadInput(entry.acp)) &&
            (entry.repositoryWorkspace === undefined ||
              (isRecord(entry.repositoryWorkspace) &&
                typeof entry.repositoryWorkspace.agentId === "string" &&
                typeof entry.repositoryWorkspace.sessionKey === "string" &&
                typeof entry.repositoryWorkspace.workspaceId === "string")),
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
      (input.command.type === "gatewayOwnerLease.read" &&
        typeof input.command.schemaMaintenance === "boolean") ||
      input.command.type === "subagents.sessionList" ||
      (input.command.type === "subagents.forChildSession" &&
        typeof input.command.childSessionKey === "string") ||
      (input.command.type === "subagents.runs" &&
        isRecord(input.command.scope) &&
        (input.command.scope.kind === "maintenance" ||
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
      input.command.type === "subagents.restore" ||
      input.command.type === "exec-approvals.read" ||
      (input.command.type === "skillLibrary.read" &&
        isRecord(input.command.input) &&
        typeof input.command.input.kind === "string" &&
        [
          "presentation",
          "list",
          "read",
          "seed",
          "session",
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
      (input.command.type === "agentLifecycle.read" && typeof input.command.input === "string") ||
      (input.command.type === "agentDeletion.sessionStoreBlocker" &&
        isRecord(input.command.input) &&
        isRecord(input.command.input.config) &&
        typeof input.command.input.agentId === "string" &&
        input.command.input.databasePath === input.databasePath &&
        isRecord(input.command.input.targets) &&
        isStringArray(input.command.input.targets.stores) &&
        Array.isArray(input.command.input.targets.candidates) &&
        input.command.input.targets.candidates.every(
          (candidate) =>
            isRecord(candidate) &&
            typeof candidate.path === "string" &&
            isRecord(candidate.identity) &&
            typeof candidate.identity.key === "string" &&
            typeof candidate.identity.canonicalPath === "string" &&
            (candidate.identity.birthtime === undefined ||
              typeof candidate.identity.birthtime === "string"),
        ) &&
        isRecord(input.command.input.env) &&
        Object.values(input.command.input.env).every(
          (value) => value === undefined || typeof value === "string",
        )) ||
      input.command.type === "agentDatabaseRegistry.read" ||
      (input.command.type === "agentDatabaseDeletion.snapshot" &&
        (input.command.purpose === "runtime" || input.command.purpose === "maintenance")) ||
      (input.command.type === "agentDeletionJournal.status" &&
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
      (input.command.type === "userModelAccounts.summary" &&
        typeof input.command.profileId === "string" &&
        typeof input.command.authProfileId === "string") ||
      (input.command.type === "userModelAccounts.selection" &&
        (input.command.profileId === undefined || typeof input.command.profileId === "string") &&
        typeof input.command.authProfileId === "string") ||
      (input.command.type === "userModelAccounts.catalog" &&
        isRecord(input.command.selection) &&
        (typeof input.command.selection.profileId === "string" ||
          typeof input.command.selection.requesterProfileId === "string")) ||
      (input.command.type === "userBackground.snapshot" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userBackground.image" &&
        typeof input.command.includeBytes === "boolean" &&
        typeof input.command.profileId === "string" &&
        typeof input.command.assetId === "string") ||
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
      (input.command.type === "githubPublications.sharedRead" &&
        isRecord(input.command.input) &&
        ("requestId" in input.command.input
          ? typeof input.command.input.requestId === "string"
          : typeof input.command.input.sessionId === "string" &&
            typeof input.command.input.idempotencyKey === "string")) ||
      (input.command.type === "githubPublications.sharedList" &&
        isRecord(input.command.input) &&
        (input.command.input.pending === undefined ||
          typeof input.command.input.pending === "boolean") &&
        (input.command.input.status === undefined ||
          (typeof input.command.input.status === "string" &&
            ["requested", "publishing", "published", "failed"].includes(
              input.command.input.status,
            ))) &&
        (input.command.input.claimNull === undefined ||
          typeof input.command.input.claimNull === "boolean") &&
        (input.command.input.sessionId === undefined ||
          typeof input.command.input.sessionId === "string") &&
        (input.command.input.unreported === undefined ||
          typeof input.command.input.unreported === "boolean")) ||
      (input.command.type === "githubPublications.claimRequests" &&
        isRecord(input.command.input) &&
        isRecord(input.command.input.claim) &&
        typeof input.command.input.claim.sessionId === "string" &&
        typeof input.command.input.claim.claimId === "string" &&
        typeof input.command.input.claim.runId === "string" &&
        (input.command.input.pendingOnly === undefined ||
          typeof input.command.input.pendingOnly === "boolean")) ||
      (input.command.type === "githubPublications.personalRead" &&
        isRecord(input.command.input) &&
        typeof input.command.input.owner === "string" &&
        isRecord(input.command.input.request) &&
        ("requestId" in input.command.input.request
          ? typeof input.command.input.request.requestId === "string"
          : "sessionId" in input.command.input.request
            ? typeof input.command.input.request.sessionId === "string" &&
              typeof input.command.input.request.idempotencyKey === "string"
            : typeof input.command.input.request.sessionKey === "string" &&
              typeof input.command.input.request.agentId === "string")) ||
      (input.command.type === "githubPublications.unreported" &&
        input.command.input === undefined) ||
      (input.command.type === "githubPublications.repositoryList" &&
        isRecord(input.command.input) &&
        (input.command.input.sessionId === undefined ||
          typeof input.command.input.sessionId === "string") &&
        (input.command.input.sessionKey === undefined ||
          typeof input.command.input.sessionKey === "string") &&
        (input.command.input.agentId === undefined ||
          typeof input.command.input.agentId === "string") &&
        (input.command.input.workspaceId === undefined ||
          typeof input.command.input.workspaceId === "string") &&
        (input.command.input.ownerProfileId === undefined ||
          input.command.input.ownerProfileId === null ||
          typeof input.command.input.ownerProfileId === "string") &&
        (input.command.input.idempotencyKey === undefined ||
          typeof input.command.input.idempotencyKey === "string") &&
        (input.command.input.pending === undefined ||
          typeof input.command.input.pending === "boolean") &&
        (input.command.input.unreported === undefined ||
          typeof input.command.input.unreported === "boolean")) ||
      (input.command.type === "githubPublications.branch" &&
        isRecord(input.command.input) &&
        typeof input.command.input.workspaceId === "string" &&
        typeof input.command.input.branch === "string" &&
        typeof input.command.input.pushRepository === "string") ||
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
        typeof input.command.profileId === "string" &&
        (input.command.includeProfile === undefined ||
          typeof input.command.includeProfile === "boolean")) ||
      (input.command.type === "userProfiles.aliases.resolve" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.githubIdentity.cached" &&
        ((typeof input.command.accountId === "number" && typeof input.command.email === "string") ||
          typeof input.command.login === "string")) ||
      (input.command.type === "userProfiles.githubAttribution.resolve" &&
        isStringArray(input.command.profileIds)) ||
      (input.command.type === "userProfiles.catalogIdentity" &&
        isRecord(input.command.input) &&
        ((input.command.input.kind === "source" && isStringArray(input.command.input.profileIds)) ||
          (input.command.input.kind === "link" &&
            isStringArray(input.command.input.accountIds) &&
            isStringArray(input.command.input.owners)))) ||
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
      ((input.command.type === "operatorApprovals.placementGrant" ||
        input.command.type === "operatorApprovals.history" ||
        input.command.type === "operatorApprovals.listCronGrants" ||
        input.command.type === "operatorApprovals.validateCronGrant") &&
        isRecord(input.command.input)) ||
      isTuiLastSessionReadCommand(input.command) ||
      input.command.type === "nodeHost.config" ||
      input.command.type === "tts.prefsPath" ||
      input.command.type === "voicewake.triggers" ||
      input.command.type === "voicewake.routing" ||
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
      input.command.type === "worktrees.cleanupState" ||
      input.command.type === "worktrees.list" ||
      (input.command.type === "workerPlacements.changeSnapshot" &&
        (input.command.profileIds === undefined || isStringArray(input.command.profileIds))) ||
      isWorkspaceJournalReadCommand(input.command) ||
      input.command.type === "workers.placementRecoveryCandidates" ||
      input.command.type === "workers.placementPreservation" ||
      (input.command.type === "workers.placementEnvironmentOwner" &&
        typeof input.command.environmentId === "string") ||
      (input.command.type === "workers.placementPendingResults" &&
        (input.command.sessionId === undefined || typeof input.command.sessionId === "string")) ||
      (input.command.type === "workers.placementProjection" &&
        isStringArray(input.command.sessionIds) &&
        Array.isArray(input.command.conflictBindings)))
  );
}
