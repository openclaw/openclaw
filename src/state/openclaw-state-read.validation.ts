import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Check } from "typebox/value";
import { SKILL_LIBRARY_MAX_SELECTIONS } from "../../packages/gateway-protocol/src/schema/skill-library.js";
import { UserChannelIdentitySchema } from "../../packages/gateway-protocol/src/schema/users.js";
import { isPluginBlobReadCommand } from "../plugin-state/plugin-blob-worker-contract.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";

export function isReadRequest(input: unknown): input is OpenClawStateReadRequest {
  if (!isRecord(input) || !isRecord(input.context) || !isRecord(input.command)) {
    return false;
  }
  const { environment, coordinatorRuntime } = input.context;
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
    isRecord(coordinatorRuntime) &&
    typeof coordinatorRuntime.directory === "string" &&
    typeof coordinatorRuntime.keepAlive === "boolean" &&
    ((input.command.type === "mcpOAuth.statuses" &&
      Array.isArray(input.command.input) &&
      input.command.input.every((key) => typeof key === "string")) ||
      ((input.command.type === "mcpOAuth.readOnly" ||
        input.command.type === "mcpOAuth.keys" ||
        input.command.type === "mcpOAuth.pending" ||
        input.command.type === "mcpOAuth.countPrincipals") &&
        typeof input.command.input === "string") ||
      isPluginBlobReadCommand(input.command) ||
      (input.command.type === "conversationBindings.inspect" &&
        isRecord(input.command.conversation) &&
        typeof input.command.conversation.channel === "string" &&
        typeof input.command.conversation.accountId === "string" &&
        typeof input.command.conversation.conversationId === "string" &&
        (input.command.conversation.parentConversationId === undefined ||
          typeof input.command.conversation.parentConversationId === "string")) ||
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
      input.command.type === "subagents.sessionList" ||
      (input.command.type === "subagents.runs" &&
        isRecord(input.command.scope) &&
        ((input.command.scope.kind === "session" &&
          typeof input.command.scope.sessionKey === "string") ||
          (input.command.scope.kind === "ids" &&
            Array.isArray(input.command.scope.runIds) &&
            input.command.scope.runIds.every((runId: unknown) => typeof runId === "string")))) ||
      input.command.type === "exec-approvals.read" ||
      ((input.command.type === "skills.library.descriptions" ||
        input.command.type === "skills.library.manifests") &&
        Array.isArray(input.command.input) &&
        input.command.input.length <= SKILL_LIBRARY_MAX_SELECTIONS &&
        input.command.input.every(
          (pin) =>
            isRecord(pin) && typeof pin.skillId === "string" && typeof pin.revision === "string",
        )) ||
      input.command.type === "agentDatabaseRegistry.read" ||
      (input.command.type === "workerEnvironments.snapshot" &&
        (input.command.ids === undefined ||
          (Array.isArray(input.command.ids) &&
            input.command.ids.every((id) => typeof id === "string")))) ||
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
      (input.command.type === "userProfiles.reconcile" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.channelIdentity.list" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.authority.resolve" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.githubIdentity.cached" &&
        typeof input.command.accountId === "number" &&
        typeof input.command.email === "string") ||
      (input.command.type === "userProfiles.channelIdentity.resolve" &&
        Check(UserChannelIdentitySchema, input.command.identity)) ||
      (input.command.type === "userProfiles.email.resolve" &&
        typeof input.command.email === "string") ||
      (input.command.type === "audit.run.inspect" &&
        isRecord(input.command.input) &&
        typeof input.command.input.now === "number" &&
        (typeof input.command.input.runId === "string" ||
          typeof input.command.input.executionId === "string")) ||
      (input.command.type === "workspace.snapshot" &&
        typeof input.command.workspaceDir === "string") ||
      (input.command.type === "updateRuns.get" && typeof input.command.runId === "string") ||
      input.command.type === "updateRuns.interruptedCandidate" ||
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
      (input.command.type === "operatorApprovals.history" && isRecord(input.command.input)) ||
      input.command.type === "nodeHost.config" ||
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
      input.command.type === "workerPlacements.changeSnapshot" ||
      (input.command.type === "workers.placementProjection" &&
        Array.isArray(input.command.sessionIds) &&
        input.command.sessionIds.every((id) => typeof id === "string") &&
        Array.isArray(input.command.conflictBindings)))
  );
}
