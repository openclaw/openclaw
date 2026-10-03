import { isChannelIngressReadCommand } from "../channels/message/ingress-queue-read-contract.js";
import { isWorkspaceJournalReadCommand } from "../gateway/worker-environments/placement-workspace-journal.types.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

export function captureCommand(command: OpenClawStateReadCommand): OpenClawStateReadCommand {
  if (command.type === "sessionState.versions" || command.type === "sessionState.events") {
    return structuredClone(command);
  }
  if (isWorkspaceJournalReadCommand(command)) {
    return command.type === "placementJournals.owners"
      ? { ...command }
      : { ...command, owner: { ...command.owner } };
  }
  if (command.type === "workerPlacements.changeSnapshot" && command.profileIds) {
    return { ...command, profileIds: [...command.profileIds] };
  }
  if (command.type === "cron.scratch") {
    return { ...command, selector: { ...command.selector } };
  }
  if (command.type === "userProfiles.avatar.read") {
    return { ...command, expected: { ...command.expected } };
  }
  if (command.type === "channelIngress.failedHealth") {
    return { type: command.type };
  }
  if (command.type === "channelIngress.pressureHealth") {
    return { type: command.type, input: { now: command.input.now } };
  }
  if (command.type === "channelIngress.accounts") {
    return { type: command.type, input: { channelId: command.input.channelId } };
  }
  if (command.type === "cron.jobNames") {
    return { ...command, jobIds: [...command.jobIds] };
  }
  if (command.type === "cron.quarantine") {
    return { type: command.type, storeKey: command.storeKey };
  }
  if (command.type === "githubPublication.sharedObservation") {
    return {
      type: command.type,
      input: {
        ...command.input,
        session: { ...command.input.session },
        selector: { ...command.input.selector },
        entry: {
          ...command.input.entry,
          ...(command.input.entry.worktree
            ? { worktree: { ...command.input.entry.worktree } }
            : {}),
        },
      },
    };
  }
  if (command.type === "sessionRepositoryWorkspaces.find") {
    return {
      type: command.type,
      owners: command.owners.map(({ agentId, sessionKey }) => ({ agentId, sessionKey })),
    };
  }
  if (command.type === "userProfiles.channelIdentity.resolve") {
    return { type: command.type, identity: structuredClone(command.identity) };
  }
  if (
    command.type === "userProfiles.githubAttribution.resolve" ||
    command.type === "userPreferences.values"
  ) {
    return { ...command, profileIds: [...command.profileIds] };
  }
  if (command.type === "subagents.runs") {
    return {
      ...command,
      scope:
        command.scope.kind === "descendants"
          ? {
              kind: "descendants",
              sessionKeys: [...command.scope.sessionKeys],
              liveTopology: command.scope.liveTopology.map((link) => ({ ...link })),
            }
          : command.scope.kind === "ids"
            ? { kind: "ids", runIds: [...command.scope.runIds] }
            : { ...command.scope },
    };
  }
  if (command.type === "mcpOAuth.statuses") {
    return { type: command.type, input: [...command.input] };
  }
  if (command.type === "sessionGroups.members") {
    return { ...command, cfg: structuredClone(command.cfg) };
  }
  if (command.type === "conversationBindings.inspect") {
    const { channel, accountId, conversationId, parentConversationId } = command.conversation;
    return {
      type: command.type,
      conversation: {
        channel,
        accountId,
        conversationId,
        ...(parentConversationId !== undefined ? { parentConversationId } : {}),
      },
    };
  }
  if (command.type === "cron.currentReceipt") {
    const { receiptId, storeKey, jobId, agentId, ownerPid, ownerStartTime } = command.handle;
    return {
      type: command.type,
      handle: { receiptId, storeKey, jobId, agentId, ownerPid, ownerStartTime },
      includeJob: command.includeJob,
      includeAvailability: command.includeAvailability,
    };
  }
  if (command.type === "cron.observeRunRecovery") {
    return {
      type: command.type,
      storeKey: command.storeKey,
      proposals: command.proposals.map(({ jobId, queuedAtMs, runningAtMs }) => ({
        jobId,
        ...(queuedAtMs === undefined ? {} : { queuedAtMs }),
        ...(runningAtMs === undefined ? {} : { runningAtMs }),
      })),
    };
  }
  if (command.type === "devicePairing.bootstrapContext") {
    return { ...command, input: { ...command.input } };
  }
  if (
    command.type === "operatorApprovals.history" ||
    command.type === "diagnostic.latest" ||
    command.type === "operatorApprovals.listCronGrants"
  ) {
    return structuredClone(command);
  }
  if (
    command.type === "acpSessions.metadata" ||
    command.type === "githubPublication.knownPullRequestUrls" ||
    command.type === "githubRepository.knownPullRequestUrls" ||
    command.type === "workers.placementProjection"
  ) {
    return structuredClone(command);
  }
  if (command.type === "pluginBlob.lookup") {
    const { pluginId, namespace, key } = command.input;
    return { type: command.type, input: { pluginId, namespace, key } };
  }
  if (command.type === "pluginBlob.entries") {
    const { pluginId, namespace } = command.input;
    return { type: command.type, input: { pluginId, namespace } };
  }
  if (command.type === "updateRuns.list") {
    return { ...command, input: { ...command.input } };
  }
  if (command.type === "updateRuns.reconciliationCandidates") {
    return {
      ...command,
      input: {
        ...command.input,
        ...(command.input.runIds ? { runIds: [...command.input.runIds] } : {}),
      },
    };
  }
  if (
    command.type === "skills.library.descriptions" ||
    command.type === "skills.library.manifests"
  ) {
    return {
      type: command.type,
      input: command.input.map(({ skillId, revision }) => ({ skillId, revision })),
    };
  }
  if (command.type === "audit.run.inspect") {
    const input = command.input;
    const common = {
      now: input.now,
      decisionCursor: input.decisionCursor,
      decisionLimit: input.decisionLimit,
    };
    return {
      type: command.type,
      input:
        "executionId" in input
          ? { ...common, executionId: input.executionId }
          : {
              ...common,
              runId: input.runId,
              executionOffset: input.executionOffset,
              executionLimit: input.executionLimit,
            },
    };
  }
  if (command.type === "workerEnvironments.pruneCandidates") {
    return {
      type: command.type,
      input: {
        ...command.input,
        cursor: command.input.cursor ? { ...command.input.cursor } : undefined,
      },
    };
  }
  if (command.type === "workerEnvironments.snapshot") {
    return { type: command.type, ...(command.ids ? { ids: [...command.ids] } : {}) };
  }
  return { ...command };
}

function commandBytes(command: OpenClawStateReadRequest["command"]): number {
  if (command.type === "sessionState.versions" || command.type === "sessionState.events") {
    return Buffer.byteLength(JSON.stringify(command), "utf8");
  }
  if (isWorkspaceJournalReadCommand(command)) {
    return Buffer.byteLength(JSON.stringify(command), "utf8");
  }
  let bytes = Buffer.byteLength(command.type, "utf8");
  if (command.type === "diagnostic.latest") {
    return bytes + Buffer.byteLength(command.input.scope, "utf8") + 16;
  }
  if (command.type === "cron.activeReceiptOwners") {
    return bytes + Buffer.byteLength(command.agentId, "utf8");
  }
  if (command.type === "workerPlacements.changeSnapshot") {
    return (command.profileIds ?? []).reduce(
      (total, profileId) => total + Buffer.byteLength(profileId, "utf8"),
      bytes,
    );
  }
  if (command.type === "tui.lastSession.read") {
    return bytes + Buffer.byteLength(command.stateKey, "utf8");
  }
  if (isChannelIngressReadCommand(command)) {
    return bytes + Buffer.byteLength(JSON.stringify(command.input ?? null), "utf8");
  }
  if (command.type === "acpSessions.metadata") {
    return command.entries.reduce(
      (total, input) =>
        total +
        input.keys.reduce((sum, key) => sum + Buffer.byteLength(key, "utf8"), 0) +
        Buffer.byteLength(input.legacyKey ?? "", "utf8") +
        Buffer.byteLength(input.entry?.lifecycleRevision ?? "", "utf8") +
        Buffer.byteLength(input.entry?.sessionId ?? "", "utf8") +
        (input.entry?.sessionStartedAt === undefined ? 0 : 8),
      bytes,
    );
  }
  if (command.type === "capture.readOnlyEvents") {
    return bytes + Buffer.byteLength(command.sessionId, "utf8") + 8;
  }
  if (command.type === "capture.readOnlyBlob") {
    return bytes + Buffer.byteLength(command.blobId, "utf8");
  }
  if (command.type === "cron.jobNames") {
    return command.jobIds.reduce(
      (sum, id) => sum + Buffer.byteLength(id, "utf8"),
      bytes + Buffer.byteLength(command.storePath ?? "", "utf8"),
    );
  }
  if (command.type === "cron.quarantine") {
    return bytes + Buffer.byteLength(command.storeKey, "utf8");
  }
  if (command.type === "githubPublication.sharedObservation") {
    return bytes + Buffer.byteLength(JSON.stringify(command.input), "utf8");
  }
  if (command.type === "sessionRepositoryWorkspaces.find") {
    return command.owners.reduce(
      (total, owner) =>
        total +
        Buffer.byteLength(owner.agentId, "utf8") +
        Buffer.byteLength(owner.sessionKey, "utf8"),
      bytes,
    );
  }
  if (command.type === "agentDatabaseDeletion.snapshot") {
    return bytes + Buffer.byteLength(command.purpose, "utf8");
  }
  if (
    command.type === "agentDeletionJournal.status" ||
    command.type === "agentDeletionJournal.authority"
  ) {
    return bytes + Buffer.byteLength(command.agentId, "utf8");
  }
  if (command.type === "subagents.runs") {
    return (
      bytes +
      (command.scope.kind === "descendants"
        ? command.scope.sessionKeys.reduce(
            (total, key) => total + Buffer.byteLength(key, "utf8"),
            0,
          ) +
          command.scope.liveTopology.reduce(
            (total, link) =>
              total +
              Buffer.byteLength(link.childSessionKey, "utf8") +
              Buffer.byteLength(link.requesterSessionKey, "utf8"),
            0,
          )
        : command.scope.kind === "session"
          ? Buffer.byteLength(command.scope.sessionKey, "utf8")
          : command.scope.kind === "ids"
            ? command.scope.runIds.reduce(
                (total, runId) => total + Buffer.byteLength(runId, "utf8"),
                0,
              )
            : 0)
    );
  }
  if (command.type === "mcpOAuth.statuses") {
    return command.input.reduce((total, key) => total + Buffer.byteLength(key, "utf8"), bytes);
  }
  if (
    command.type === "mcpOAuth.readOnly" ||
    command.type === "mcpOAuth.keys" ||
    command.type === "mcpOAuth.pending" ||
    command.type === "mcpOAuth.countPrincipals"
  ) {
    return bytes + Buffer.byteLength(command.input, "utf8");
  }
  if (command.type === "sessionGroups.members") {
    return bytes + Buffer.byteLength(JSON.stringify(command.cfg), "utf8");
  }
  if (command.type === "conversationBindings.inspect") {
    return (
      bytes +
      Object.values(command.conversation).reduce(
        (sum, value) => sum + Buffer.byteLength(value ?? "", "utf8"),
        0,
      )
    );
  }
  if (command.type === "cron.currentReceipt") {
    return bytes + Buffer.byteLength(JSON.stringify(command.handle), "utf8") + 2;
  }
  if (command.type === "cron.observeRunRecovery") {
    return command.proposals.reduce(
      (total, proposal) =>
        total +
        Buffer.byteLength(proposal.jobId, "utf8") +
        (proposal.queuedAtMs === undefined ? 0 : 8) +
        (proposal.runningAtMs === undefined ? 0 : 8),
      bytes + Buffer.byteLength(command.storeKey, "utf8"),
    );
  }
  if (command.type === "cron.scratch") {
    return (
      bytes +
      Buffer.byteLength(command.storeKey, "utf8") +
      Buffer.byteLength(command.selector.kind, "utf8") +
      (command.selector.kind === "job" ? 8 : 0) +
      Buffer.byteLength(
        command.selector.kind === "job" ? command.selector.jobId : command.selector.agentId,
        "utf8",
      )
    );
  }
  if (command.type === "devicePairing.bootstrapContext") {
    return (
      bytes +
      Buffer.byteLength(command.input.token) +
      Buffer.byteLength(command.input.deviceId) +
      Buffer.byteLength(command.input.publicKey) +
      8
    );
  }
  if (command.type === "devicePairing.lookup") {
    return bytes + Buffer.byteLength(command.deviceId);
  }
  if (command.type === "devicePairing.pending") {
    return bytes + Buffer.byteLength(command.requestId) + 8;
  }
  if (command.type === "devicePairing.list") {
    return bytes + 8 + Buffer.byteLength(command.publishedRevision ?? "");
  }
  if (command.type === "operatorApprovals.history") {
    return (
      bytes +
      Buffer.byteLength(command.input.cursor ?? "", "utf8") +
      Buffer.byteLength(command.input.kind ?? "", "utf8") +
      16
    );
  }
  if (command.type === "operatorApprovals.listCronGrants") {
    return bytes + 8;
  }
  if (command.type === "deliveryQueue.outbound") {
    return bytes + Buffer.byteLength(command.id ?? "", "utf8");
  }
  if (
    command.type === "githubPublication.request" ||
    command.type === "githubRepository.request" ||
    command.type === "githubPublication.lifecycle"
  ) {
    return bytes + Buffer.byteLength(command.requestId, "utf8") + 8;
  }
  if (
    command.type === "githubPublication.knownPullRequestUrls" ||
    command.type === "githubRepository.knownPullRequestUrls"
  ) {
    return Object.values(command.input).reduce<number>(
      (total, value) => total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8),
      bytes,
    );
  }
  if (command.type === "pluginBlob.lookup" || command.type === "pluginBlob.entries") {
    return (
      bytes +
      Buffer.byteLength(command.input.pluginId, "utf8") +
      Buffer.byteLength(command.input.namespace, "utf8") +
      (command.type === "pluginBlob.lookup" ? Buffer.byteLength(command.input.key, "utf8") : 0)
    );
  }
  if (command.type === "subagents.forChildSession") {
    return bytes + Buffer.byteLength(command.childSessionKey, "utf8");
  }
  if (command.type === "sandboxRegistry.get") {
    return bytes + Buffer.byteLength(command.containerName, "utf8");
  }
  if (command.type === "sandboxRegistry.runtimeIds") {
    return (
      bytes +
      Buffer.byteLength(command.backendId, "utf8") +
      Buffer.byteLength(command.scopeKey, "utf8")
    );
  }
  if (command.type === "updateRuns.get" || command.type === "updateRuns.reconciliationCandidate") {
    return bytes + Buffer.byteLength(command.runId, "utf8");
  }
  if (command.type === "updateRuns.reconciliationCandidates") {
    return (command.input.runIds ?? []).reduce(
      (total, runId) => total + Buffer.byteLength(runId, "utf8"),
      bytes + 3 + (command.input.repairHistorySinceMs === undefined ? 0 : 8),
    );
  }
  if (command.type === "updateRuns.list") {
    return (
      bytes +
      Buffer.byteLength(command.input.reason ?? "", "utf8") +
      Buffer.byteLength(command.input.includeRunId ?? "", "utf8") +
      (command.input.limit === undefined ? 0 : 8) +
      (command.input.active === undefined ? 0 : 1)
    );
  }
  if (
    command.type === "skills.library.descriptions" ||
    command.type === "skills.library.manifests"
  ) {
    return command.input.reduce(
      (total, pin) =>
        total + Buffer.byteLength(pin.skillId, "utf8") + Buffer.byteLength(pin.revision, "utf8"),
      bytes,
    );
  }
  if (command.type === "fleet.get") {
    return bytes + Buffer.byteLength(command.tenantId, "utf8");
  }
  if (command.type === "onboardingRecommendations.read") {
    return bytes + Buffer.byteLength(command.configKey, "utf8");
  }
  if (
    command.type === "userModelAccounts.links" ||
    command.type === "userProfiles.reconcile" ||
    command.type === "userProfiles.avatar.inspect" ||
    command.type === "userProfiles.channelIdentity.list" ||
    command.type === "userProfiles.authority.resolve"
  ) {
    return bytes + Buffer.byteLength(command.profileId, "utf8");
  }
  if (command.type === "userProfiles.avatar.read") {
    return (
      bytes +
      Buffer.byteLength(command.profileId, "utf8") +
      Object.values(command.expected).reduce(
        (total, value) => total + Buffer.byteLength(value, "utf8"),
        0,
      )
    );
  }
  if (command.type === "userProfiles.githubIdentity.cached") {
    return bytes + Buffer.byteLength(command.email, "utf8") + 8;
  }
  if (
    command.type === "userProfiles.githubAttribution.resolve" ||
    command.type === "userPreferences.values"
  ) {
    return command.profileIds.reduce(
      (total, profileId) => total + Buffer.byteLength(profileId, "utf8"),
      bytes + (command.type === "userPreferences.values" ? Buffer.byteLength(command.key) : 0),
    );
  }
  if (command.type === "userProfiles.channelIdentity.resolve") {
    return bytes + Buffer.byteLength(JSON.stringify(command.identity), "utf8");
  }
  if (command.type === "userProfiles.email.resolve") {
    return bytes + Buffer.byteLength(command.email, "utf8");
  }
  if (command.type === "workspace.snapshot") {
    return bytes + Buffer.byteLength(command.workspaceDir, "utf8");
  }
  if (command.type === "audit.run.inspect") {
    const input = command.input;
    // Each supplied numeric scalar retains one eight-byte JavaScript number.
    bytes += Buffer.byteLength(input.decisionCursor ?? "", "utf8") + 8;
    if (input.decisionLimit !== undefined) {
      bytes += 8;
    }
    if ("executionId" in input) {
      return bytes + Buffer.byteLength(input.executionId, "utf8");
    }
    return (
      bytes +
      Buffer.byteLength(input.runId, "utf8") +
      (input.executionOffset === undefined ? 0 : 8) +
      (input.executionLimit === undefined ? 0 : 8)
    );
  }
  if (
    command.type === "workers.placementProjection" ||
    command.type === "workers.placementPendingResults"
  ) {
    return Buffer.byteLength(JSON.stringify(command), "utf8");
  }
  if (command.type === "workerEnvironments.pruneCandidates") {
    return (
      bytes +
      8 +
      (command.input.limit === undefined ? 0 : 8) +
      (command.input.cursor ? 8 + Buffer.byteLength(command.input.cursor.environmentId, "utf8") : 0)
    );
  }
  if (command.type === "workerEnvironments.snapshot") {
    return (
      bytes + (command.ids?.reduce((total, id) => total + Buffer.byteLength(id, "utf8"), 0) ?? 0)
    );
  }
  return bytes;
}

export function requestBytes(request: OpenClawStateReadRequest): number {
  return [
    ...Object.entries(request.context.environment).flatMap(([key, value]) => [key, value]),
    request.context.existingSchemaPath,
    request.databasePath,
    request.location,
    request.expectedIdentity,
    request.snapshotRoot,
  ].reduce(
    (bytes, value) => bytes + (value === undefined ? 0 : Buffer.byteLength(value, "utf8")),
    commandBytes(request.command),
  );
}
