import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Keep this vocabulary below database contracts to avoid broker import cycles.
// Keep caller-controlled SDK command names and suffixes out of metric labels.
const operations = [
  "admit",
  "audit.events.list",
  "audit.writer.process",
  "audit.writer.prune",
  "database.domain.bind",
  "database.domain.close",
  "database.domain.publish",
  "database.prepareWrite",
  "database.walMaintenance",
  "stateLease.acquire",
  "stateLease.release",
  "stateLease.renew",
  "stateLease.verify",
  "worktrees.assertPredicates",
  "worktrees.delete",
  "worktrees.slotCount",
  "worktrees.pendingSlots",
  "worktrees.reservePending",
  "worktrees.releasePending",
  "worktrees.insert",
  "worktrees.update",
  "worktrees.claimRemoval",
  "worktrees.finalizeRemoval",
  "worktrees.abortRemoval",
  "worktrees.findLiveByOwner",
  "worktrees.get",
  "worktrees.sessionBinding",
  "worktrees.findLiveByPath",
  "worktrees.list",
  "worktrees.liveIds",
  "worktrees.provisionedPaths",
  "worktrees.provisionedState",
  "worktrees.provisionedChunk",
  "worktrees.writeProvisionedSnapshot",
  "worktrees.retireMissing",
  "worktrees.deferCleanup",
  "worktrees.admitRunLease",
  "worktrees.releaseRunLease",
  "worktrees.reapRunLeases",
  "worktrees.reserveCapacity",
  "worktrees.recoverPending",
  "worktrees.templates.read",
  "worktrees.templates.has",
  "worktrees.templates.list",
  "worktrees.templates.reserve",
  "worktrees.templates.ready",
  "worktrees.templates.delete",
  "worktrees.templates.retainReader",
  "worktrees.templates.releaseReader",
  "worktrees.templates.hasReaders",
] as const;

const families = [
  "acp",
  "acpSessions",
  "agentDatabaseDeletion",
  "agentDatabaseRegistry",
  "agentDatabases",
  "agentDeletionJournal",
  "agentProvenance",
  "apns",
  "audit",
  "authProfiles",
  "backup",
  "bootstrap",
  "capture",
  "channelIngress",
  "claws",
  "config",
  "conversation",
  "conversationBindings",
  "database",
  "deliveryQueue",
  "deviceAuth",
  "deviceIdentity",
  "devicePairing",
  "diagnostic",
  "doctor",
  "exec-approvals",
  "execApprovals",
  "generatedHtmlProvenance",
  "githubPublication",
  "githubRepository",
  "legacyMcpOAuth",
  "localWorkspace",
  "managedImages",
  "mcpOAuth",
  "mentions",
  "modelCatalog",
  "nativeHookRelay",
  "node",
  "nodeHost",
  "nodeWorker",
  "onboardingRecommendations",
  "operator",
  "operatorApprovals",
  "pairing",
  "placementJournals",
  "placementTools",
  "placementTranscript",
  "placementTurns",
  "pluginBlob",
  "pluginModelCatalogCredentials",
  "plugins",
  "preparedPoolPresence",
  "projects",
  "promotions",
  "repositoryWorkspaces",
  "restartSentinel",
  "sandboxRegistry",
  "secrets",
  "sessionDelivery",
  "sessionGroups",
  "sessionRepositoryWorkspaces",
  "sessionState",
  "sessionUpstream",
  "skillLibrary",
  "skillUploads",
  "skills",
  "stateLease",
  "subagents",
  "telemetry",
  "tts",
  "tui",
  "updateRuns",
  "usageCache",
  "userModelAccounts",
  "userPreferences",
  "userProfiles",
  "webPush",
  "workerEnvironments",
  "workerInference",
  "workerPlacements",
  "workers",
  "workspace",
  "workshop",
  "worktrees",
] as const;

export const sqliteWorkerRequestClasses: ReadonlySet<string> = new Set([
  ...operations,
  ...families,
]);

export function classifySqliteWorkerExecute(commandType: string): string {
  if (sqliteWorkerRequestClasses.has(commandType)) {
    return commandType;
  }
  const separator = commandType.indexOf(".");
  const family = separator === -1 ? commandType : commandType.slice(0, separator);
  return sqliteWorkerRequestClasses.has(family) ? family : "execute";
}

// Exact owner commands only: SDK callers may supply private suffixes.
const coreCommands = new Set([
  "devicePairing.lookup",
  "devicePairing.list",
  "devicePairing.updateMetadata",
  "devicePairing.updatePresence",
  "devicePairing.verifyToken",
  "devicePairing.ensureToken",
  "session.actor.read",
  "session.actor.acceptInput",
  "session.actor.adoptRun",
  "session.actor.appendToolResult",
  "session.actor.appendTranscriptEvent",
  "session.actor.completeTurn",
  "session.actor.deliveryPending",
  "session.actor.deliverySettled",
  "session.actor.patch",
  "session.entry.read",
  "session.entry.patch.prepare",
  "session.entry.patch.commit",
  "session.entry.replacements.prepare",
  "session.entry.replacements.commit",
  "session.lifecycle.project",
  "session.maintenance.metadata",
  "session.maintenance.prepare",
  "session.maintenance.finalize",
  "session.maintenance.size",
  "session.rowTranscript.backfill",
  "usageCache.writeRollup",
  "usageCache.writeQuarters",
  "usageCache.prune",
  "trajectory.events.append",
  "trajectory.retention.begin",
  "trajectory.retention.delete",
  "session.pendingInputs.read",
  "session.pendingInputs.mutate",
  "session.turn.prepare",
  "session.turn.commit",
  "transcript.prepare",
  "transcript.commit",
]);

const projectionCommands = new Map([
  ["preflight", "transcript-projection.preflight"],
  ["sweep", "transcript-projection.sweep"],
  ["claim", "transcript-projection.claim"],
  ["deleteChunk", "transcript-projection.deleteChunk"],
  ["appendChunk", "transcript-projection.appendChunk"],
  ["finalize", "transcript-projection.finalize"],
]);
const projectionModuleSuffixes = [
  "/config/sessions/session-transcript-projection-publication.worker.js",
  "/config/sessions/session-transcript-projection-publication.worker.ts",
];

const requestPrefixes = [
  ["pluginState.", "plugin_state"],
  ["session.history.", "transcript_read"],
  ["trajectory.", "transcripts"],
  ["session.transcript.", "transcripts"],
  ["transcripts.", "transcripts"],
  ["session.", "sessions"],
  ["cron.", "cron"],
] as const;

export function classifyWorkerRequest(commandType: unknown, commandInput?: unknown): string {
  if (typeof commandType !== "string") {
    return "execute";
  }
  if (coreCommands.has(commandType)) {
    return commandType;
  }
  if (commandType === "auth-profile-rows") {
    return "auth_profiles";
  }
  if (commandType === "database.domain.execute" || commandType === "database.domain.publish") {
    const publication = isRecord(commandInput) ? commandInput : undefined;
    const inner = publication && isRecord(publication.command) ? publication.command : undefined;
    const moduleUrl = publication?.moduleUrl;
    // Bare commands such as claim also belong to other owners. Never log their module paths.
    if (
      commandType === "database.domain.publish" &&
      typeof moduleUrl === "string" &&
      typeof inner?.type === "string" &&
      projectionModuleSuffixes.some((suffix) => moduleUrl.endsWith(suffix))
    ) {
      const projection = projectionCommands.get(inner.type);
      if (projection) {
        return projection;
      }
    }
    const label = inner ? classifyWorkerRequest(inner.type) : "execute";
    return label === "execute" ? "domain_execute" : label;
  }
  for (const [prefix, requestClass] of requestPrefixes) {
    if (commandType.startsWith(prefix)) {
      return requestClass;
    }
  }
  return classifySqliteWorkerExecute(commandType);
}

const requestClasses = new Set([
  ...coreCommands,
  ...projectionCommands.values(),
  ...sqliteWorkerRequestClasses,
  ...requestPrefixes.map(([, requestClass]) => requestClass),
  "task",
  "open",
  "close",
  "execute",
  "domain_execute",
  "auth_profiles",
]);

export function normalizeWorkerRequestClass(requestClass: string | undefined): string {
  return requestClass !== undefined && requestClasses.has(requestClass) ? requestClass : "other";
}
