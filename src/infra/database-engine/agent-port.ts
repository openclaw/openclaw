import path from "node:path";
import { getDatabaseEngineSelection, withDatabaseEngineSelection } from "./context.js";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const agentPortProvider: DatabasePortProvider = {
  id: "agent",
  minimumPostgresVersion: 16,
  async loadDescriptor() {
    const { loadAgentPortDescriptor } = await import("./agent-port-descriptor.js");
    return loadAgentPortDescriptor();
  },
  matchesSqlite: (tables) =>
    ["schema_meta", "session_nodes", "transcript_events"].every((table) => tables.has(table)),
  resolveRoots: resolveAgentPortRoots,
};

/** Include retained registrations even when their agent is no longer configured. */
export async function resolveAgentPortRoots(
  context: Pick<Parameters<DatabasePortProvider["resolveRoots"]>[0], "config" | "stateDir" | "env">,
): Promise<string[]> {
  const [
    { resolveSharedMainAuthAgentDir },
    { resolveConfiguredAgentDatabaseTargets },
    { listDefaultAgentDatabasePaths },
    { inspectOpenClawRegisteredAgentDatabases },
    { resolveDatabaseEngineInput },
  ] = await Promise.all([
    import("../../agents/auth-profiles/shared-main-dir.js"),
    import("../../config/sessions/targets.js"),
    import("../../state/agent-database-path-discovery.js"),
    import("../../state/openclaw-agent-db-registry-listing.js"),
    import("./config.js"),
  ]);
  const env = { ...context.env, OPENCLAW_STATE_DIR: context.stateDir };
  const selection = getDatabaseEngineSelection() ?? {
    input: await resolveDatabaseEngineInput(context.config, env),
  };
  const registered = await withDatabaseEngineSelection(selection, () =>
    inspectOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true }),
  );
  return [
    ...new Set([
      path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite"),
      ...(await listDefaultAgentDatabasePaths(context.stateDir)).map((entry) => entry.path),
      ...resolveConfiguredAgentDatabaseTargets(context.config, {
        env,
        registeredDatabases: registered,
      }).map((entry) => entry.path),
      ...registered.map((entry) => entry.path),
    ]),
  ];
}
