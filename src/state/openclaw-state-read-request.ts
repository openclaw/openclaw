import { isWorkspaceJournalReadCommand } from "../gateway/worker-environments/placement-workspace-journal.types.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

export function captureCommand(command: OpenClawStateReadCommand): OpenClawStateReadCommand {
  if (command.type === "userProfiles.catalogIdentity") {
    return { ...command, input: structuredClone(command.input) };
  }
  if (command.type === "meetingTranscripts.export") {
    return structuredClone(command);
  }
  if (
    command.type === "localWorkspace.get" ||
    command.type === "localWorkspace.exists" ||
    command.type === "pairing.allowFrom" ||
    command.type === "secrets.metadata" ||
    command.type === "secrets.execEnvironment" ||
    command.type === "secrets.value" ||
    command.type === "sessionState.versions" ||
    command.type === "sessionState.ambientTargets" ||
    command.type === "sessionState.events" ||
    command.type === "sessionUpstream.read" ||
    command.type === "operatorApprovals.placementGrant" ||
    command.type === "operatorApprovals.history" ||
    command.type === "diagnostic.latest" ||
    command.type === "diagnostic.configAuditFacts" ||
    command.type === "operatorApprovals.listCronGrants" ||
    command.type === "operatorApprovals.validateCronGrant" ||
    command.type === "acpSessions.metadata" ||
    command.type === "sessionRows.sharedFacts" ||
    command.type === "agentDeletion.sessionStoreBlocker" ||
    command.type === "githubPublication.knownPullRequestUrls" ||
    command.type === "githubRepository.knownPullRequestUrls" ||
    command.type === "workers.placementProjection"
  ) {
    return structuredClone(command);
  }
  if (
    command.type === "clawMonitorCleanup.snapshot" ||
    command.type === "clawMonitorCleanup.portable"
  ) {
    return structuredClone(command);
  }
  if (
    command.type === "automationProactive.receipts" ||
    command.type === "automationProactive.jobs"
  ) {
    return { ...command, input: { ...command.input, agentIds: [...command.input.agentIds] } };
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

function stringBytes(values: readonly (string | undefined)[]): number {
  return values.reduce((bytes, value) => bytes + Buffer.byteLength(value ?? "", "utf8"), 0);
}

// Account for the captured payload, not a second per-command schema. Object keys
// and escaped strings deliberately overcharge the queue rather than omit new fields.
function commandBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return 8;
  }
  if (typeof value === "boolean") {
    return 1;
  }
  if (value === null || value === undefined) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((bytes, entry) => bytes + 8 + commandBytes(entry), 0);
  }
  return Object.entries(value).reduce(
    (bytes, [key, entry]) => bytes + Buffer.byteLength(key, "utf8") + 8 + commandBytes(entry),
    0,
  );
}

export function requestBytes(request: OpenClawStateReadRequest): number {
  return (
    commandBytes(request.command) +
    stringBytes([
      ...Object.entries(request.context.environment).flatMap(([key, value]) => [key, value]),
      request.context.existingSchemaPath,
      request.databasePath,
      request.location,
      request.expectedIdentity,
      request.snapshotRoot,
    ])
  );
}
