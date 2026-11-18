import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import { createAgentDatabaseDeletionClassifier } from "../state/agent-deletion-discovery.js";
import { readRetainedAgentDeletionsFromDatabase } from "../state/agent-deletion-journal.read.js";
import type { EngineConnection } from "./sql-connection.js";

/** Classify held stores from the same private shared-state generation as the schema inventory. */
export function readUpdateHeldAgentPaths(
  db: EngineConnection,
  shared: string,
  files: Iterable<{ spellings: string[] }>,
  registered: { agentId: string | null; source: string }[],
  input: { stateDir: string; config: OpenClawConfigWithLegacyRoster; env?: NodeJS.ProcessEnv },
): string[] {
  const env = { ...(input.env ?? process.env), OPENCLAW_STATE_DIR: input.stateDir };
  const registeredAgentDatabases = registered.flatMap(({ agentId, source }) =>
    typeof agentId === "string" ? [{ agentId, path: source }] : [],
  );
  const classify = createAgentDatabaseDeletionClassifier({
    env,
    configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(input.config, {
      env,
      registeredDatabases: registeredAgentDatabases,
    }),
    registeredAgentDatabases,
    retainedDeletions: readRetainedAgentDeletionsFromDatabase(db, shared),
  });
  return [...files]
    .flatMap((entry) => entry.spellings)
    .filter((pathname) => {
      if (pathname === shared) {
        return false;
      }
      const deletion = classify(pathname);
      // Doctor still migrates pending deletions; only its held stores are exempt.
      return (
        deletion &&
        (typeof deletion === "string" ||
          deletion.cleanupCompleted ||
          deletion.manualTemplateRemoval)
      );
    });
}
