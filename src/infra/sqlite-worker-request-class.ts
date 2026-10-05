import type { AgentDatabaseOperations } from "../state/openclaw-agent-execution-contract.js";
import type {
  OpenClawStateWorkerCleanupOperations,
  OpenClawStateWorkerInspectionOperations,
  OpenClawStateWorkerOperations,
} from "../state/openclaw-state-worker-contract.js";

type Command = keyof (AgentDatabaseOperations &
  OpenClawStateWorkerOperations &
  OpenClawStateWorkerInspectionOperations &
  OpenClawStateWorkerCleanupOperations);
type Family<Name> = Name extends `${infer Prefix}.${string}` ? Prefix : never;

// Keep caller-controlled SDK command names and suffixes out of metric labels.
const operations = [
  "audit.events.list",
  "audit.writer.process",
  "audit.writer.prune",
  "database.domain.bind",
  "database.domain.close",
  "database.domain.publish",
  "database.generationMatches",
  "database.inspectIdle",
  "database.prepareWrite",
  "database.walMaintenance",
  "stateLease.acquire",
  "stateLease.release",
  "stateLease.renew",
  "stateLease.verify",
] satisfies readonly Command[];

const families = [
  "acp",
  "agentDatabases",
  "agentProvenance",
  "apns",
  "audit",
  "authProfiles",
  "backup",
  "bootstrap",
  "capture",
  "channelIngress",
  "clawProvenance",
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
  "execApprovals",
  "fleet",
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
  "nodeWorker",
  "onboardingRecommendations",
  "operatorApprovals",
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
  "sessionState",
  "sessionUpstream",
  "skillLibrary",
  "skillUploads",
  "skills",
  "stateLease",
  "subagents",
  "telemetry",
  "tui",
  "updateRuns",
  "usageCache",
  "userPreferences",
  "userProfiles",
  "webPush",
  "workerEnvironments",
  "workerInference",
  "workerPlacements",
  "workspace",
  "workshop",
  "worktrees",
] satisfies readonly Family<Command>[];

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
