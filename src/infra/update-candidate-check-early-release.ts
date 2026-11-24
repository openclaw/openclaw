import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import { resolveUserPath } from "./home-dir.js";
import { openNodeSqliteDatabase, resolveReadOnlyShmSqliteFileUri } from "./node-sqlite.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { collectRegisteredPaths } from "./update-candidate-state.shared.js";

/** The one-time rebuild, run from the checkout. It names no path, because the early updater
 * redacts the state and home directories out of this check's output before printing it. */
const EARLY_GIT_RELEASE_REBUILD =
  "git pull --ff-only && openclaw gateway stop --force && pnpm install --frozen-lockfile && pnpm build && openclaw gateway install --force || { openclaw gateway start; false; }";

/**
 * Updaters built from `main` between #199706 (6747b1ec5ae, 2026-11-17) and #201917
 * (2ef6f7bade7, 2026-11-19) build each Git release in `<stateDir>/git-install/releases/<id>/build`
 * behind the link `git-install/lib/node_modules/openclaw`, and run this release's `--check`
 * there. No other updater builds a release at that path.
 *
 * They cannot finish an update that changes a database schema. They never rebuild the checkout,
 * so after the Gateway on this release migrates state at boot, the updater's own process and the
 * checkout's `openclaw` on PATH refuse the newer schema. Builds before #201463 (2183caf789c) stop
 * even earlier: they require the new schema before restarting, and leave the install
 * half-switched (#203608).
 *
 * So when this release would migrate state, the check refuses before the release is switched
 * and names the one-time rebuild. Same-schema updates pass through. Returns null for every other
 * caller and when state is already current or cannot be read.
 *
 * Remove once no install can still run an updater from that window.
 */
export function refuseEarlyGitReleaseSchemaChange(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const stateDir = resolveStateDir(env);
  let state: number;
  const agents: number[] = [];
  try {
    const prefix = fs.realpathSync(path.join(stateDir, "git-install"));
    const real = fs.realpathSync(root);
    const releases = path.dirname(path.dirname(real));
    if (
      path.basename(real) !== "build" ||
      path.basename(releases) !== "releases" ||
      path.dirname(releases) !== prefix ||
      !fs.lstatSync(path.join(prefix, "lib", "node_modules", "openclaw")).isSymbolicLink()
    ) {
      return null;
    }
    const shared = resolveOpenClawStateSqlitePath(env);
    const agentPaths = new Set<string>(
      [env.OPENCLAW_AGENT_DIR, env.PI_CODING_AGENT_DIR].flatMap((dir) =>
        dir?.trim() ? [path.join(resolveUserPath(dir, env), "openclaw-agent.sqlite")] : [],
      ),
    );
    const agentsDir = path.join(stateDir, "agents");
    for (const id of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
      agentPaths.add(path.join(agentsDir, id, "agent", "openclaw-agent.sqlite"));
    }
    // readonly_shm reads committed WAL content without touching the serving Gateway's sidecars.
    const open = (file: string) =>
      openNodeSqliteDatabase(resolveReadOnlyShmSqliteFileUri(file), { readOnly: true });
    const db = open(shared);
    try {
      // A PostgreSQL store keeps a version-0 SQLite anchor; its schema lives on the server and
      // migrates through Doctor with writers stopped, which this rebuild does not cover.
      if (readSqliteUserVersion(db) === 0) {
        return null;
      }
      state = readStateSchemaContentVersion(db);
      for (const { source } of collectRegisteredPaths(db, shared, new Map())) {
        agentPaths.add(source);
      }
    } finally {
      db.close();
    }
    for (const file of [...agentPaths].filter((candidate) => fs.existsSync(candidate))) {
      const agent = open(file);
      try {
        const version = readSqliteUserVersion(agent);
        if (version === 0) {
          return null;
        }
        agents.push(version);
      } finally {
        agent.close();
      }
    }
  } catch {
    return null;
  }
  const agent = Math.min(...agents);
  if (state >= OPENCLAW_STATE_SCHEMA_VERSION && !(agent < OPENCLAW_AGENT_SCHEMA_VERSION)) {
    return null;
  }
  return [
    `OpenClaw ${VERSION} migrates your databases (state schema ${state} to ${OPENCLAW_STATE_SCHEMA_VERSION}${
      agents.length ? `, agent schema ${agent} to ${OPENCLAW_AGENT_SCHEMA_VERSION}` : ""
    }).`,
    "The updater in this checkout (a main build from 2026-11-17 to 2026-11-19) cannot finish that: after the migration, neither it nor the checkout's `openclaw` command can open the migrated data.",
    "The update stopped before switching releases; the Gateway was not touched.",
    "Rebuild the checkout once from its directory; later updates then run normally:",
    EARLY_GIT_RELEASE_REBUILD,
  ].join("\n");
}
