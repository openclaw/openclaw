import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveDaemonRuntimePinStorePath } from "../../daemon/runtime-pin-store.js";
import { resolveClientCredentialStorePath } from "../../infra/client-credential-paths.js";
import { resolveUserPath } from "../../infra/home-dir.js";
import type { StateDatabaseDiscovery } from "../../infra/update-candidate-paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

export function resolveGatewayRecoverySchemaPaths(
  env: NodeJS.ProcessEnv,
  files: ReadonlyMap<string, StateDatabaseDiscovery> = new Map(),
): Set<string> {
  const paths = new Set([
    resolveOpenClawStateSqlitePath(env),
    resolveClientCredentialStorePath(env),
    resolveDaemonRuntimePinStorePath(env),
    path.join(resolveStateDir(env), "agents", "main", "agent", "openclaw-agent.sqlite"),
    ...[env.OPENCLAW_AGENT_DIR, env.PI_CODING_AGENT_DIR].flatMap((directory) =>
      directory?.trim()
        ? [path.join(resolveUserPath(directory, env), "openclaw-agent.sqlite")]
        : [],
    ),
  ]);
  for (const database of files.values()) {
    if (database.owners?.some(({ role }) => role === "agent") || database.registeredPaths?.length) {
      database.spellings.forEach((pathname) => paths.add(pathname));
    }
  }
  return paths;
}
