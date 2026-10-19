import path from "node:path";
import type { OpenClawRegisteredAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { getDatabaseEngineSelection, withDatabaseEngineSelection } from "./context.js";
import type { DatabasePortProvider } from "./port-descriptor.js";

export const agentPortProvider: DatabasePortProvider = {
  id: "agent",
  minimumPostgresVersion: 16,
  async loadDescriptor(_owner, version) {
    const { loadAgentPortDescriptor } = await import("./agent-port-descriptor.js");
    return loadAgentPortDescriptor(version);
  },
  matchesSqlite: (tables) =>
    ["schema_meta", "session_nodes", "transcript_events"].every((table) => tables.has(table)),
  resolveRoots: resolveAgentPortRoots,
};

/** Include retained registrations even when their agent is no longer configured. */
export async function resolveAgentPortRoots(
  context: Pick<Parameters<DatabasePortProvider["resolveRoots"]>[0], "config" | "stateDir" | "env">,
  registeredDatabases?: readonly OpenClawRegisteredAgentDatabase[],
): Promise<string[]> {
  const [
    { listAgentIds },
    { resolveSharedMainAuthAgentDir },
    { resolveConfiguredAgentDatabaseTargets },
    { listDefaultAgentDatabasePaths },
    { inspectOpenClawRegisteredAgentDatabases },
    { resolveDatabaseEngineSelection },
  ] = await Promise.all([
    import("../../agents/agent-roster.js"),
    import("../../agents/auth-profiles/shared-main-dir.js"),
    import("../../config/sessions/targets.js"),
    import("../../state/agent-database-path-discovery.js"),
    import("../../state/openclaw-agent-db-registry-listing.js"),
    import("./config.js"),
  ]);
  const env = { ...context.env, OPENCLAW_STATE_DIR: context.stateDir };
  const registered =
    registeredDatabases ??
    (await withDatabaseEngineSelection(
      getDatabaseEngineSelection() ?? (await resolveDatabaseEngineSelection(context.config, env)),
      () =>
        inspectOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true }),
    ));
  return [
    ...new Set([
      path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite"),
      ...(await listDefaultAgentDatabasePaths(context.stateDir)).map((entry) => entry.path),
      ...resolveConfiguredAgentDatabaseTargets(context.config, {
        env,
        registeredDatabases: registered,
        // Unconfigured reserved stores come from discovery/registration, not expected roots.
        nativeAgentIds: new Set(listAgentIds(context.config)),
      }).map((entry) => entry.path),
      ...registered.map((entry) => entry.path),
    ]),
  ];
}
