import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { collectRegisteredPaths } from "./update-candidate-state.shared.js";

/**
 * Updaters built from `main` between #199706 (6747b1ec5ae, 2026-11-17) and #201917
 * (2ef6f7bade7, 2026-11-19) build each Git release in `<stateDir>/git-install/releases/<id>/build`
 * behind the link `git-install/lib/node_modules/openclaw`, and run this release's `--check`
 * there. No other updater builds a release at that path.
 *
 * They cannot finish an update that changes a database schema. Before restarting the Gateway they
 * require state already at this release's schema, which nothing applies while the old Gateway
 * serves, and they leave the install half-switched (#203608). If the restart did happen, the
 * Gateway on this release would migrate state at boot, and the updater's own process, and the
 * checkout's `openclaw` on PATH, which they never rebuild, refuse the newer schema.
 *
 * So when this release would migrate state, the check refuses before anything changes and says
 * how to rebuild the checkout once. Same-schema updates pass through. Returns null for every
 * other caller and when state is already current or cannot be read.
 *
 * Remove once no install can still run an updater from that window.
 */
export function refuseEarlyGitReleaseSchemaChange(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const releases = path.dirname(path.dirname(root));
  const prefix = path.join(resolveStateDir(env), "git-install");
  if (
    path.basename(root) !== "build" ||
    path.basename(releases) !== "releases" ||
    path.resolve(path.dirname(releases)) !== path.resolve(prefix) ||
    !fs
      .lstatSync(path.join(prefix, "lib", "node_modules", "openclaw"), { throwIfNoEntry: false })
      ?.isSymbolicLink()
  ) {
    return null;
  }
  let state: number;
  const agents: number[] = [];
  try {
    const shared = resolveOpenClawStateSqlitePath(env);
    const agentPaths: string[] = [];
    const db = openNodeSqliteDatabase(shared, { readOnly: true });
    try {
      state = readStateSchemaContentVersion(db);
      agentPaths.push(...collectRegisteredPaths(db, shared, new Map()).map(({ source }) => source));
    } finally {
      db.close();
    }
    for (const file of agentPaths.filter((candidate) => fs.existsSync(candidate))) {
      const agent = openNodeSqliteDatabase(file, { readOnly: true });
      try {
        agents.push(readSqliteUserVersion(agent));
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
  const checkout = readWorktreeCheckout(root) ?? "<your checkout>";
  return [
    `OpenClaw ${VERSION} migrates your databases (state schema ${state} to ${OPENCLAW_STATE_SCHEMA_VERSION}${
      agents.length ? `, agent schema ${agent} to ${OPENCLAW_AGENT_SCHEMA_VERSION}` : ""
    }).`,
    "The updater in this checkout (a main build from 2026-11-17 to 2026-11-19) cannot finish that: after the migration, neither it nor the checkout's `openclaw` command can open the migrated data.",
    "Nothing was changed, and the Gateway keeps serving the current version.",
    "Rebuild the checkout once; later updates then run normally:",
    `cd ${checkout} && openclaw gateway stop --force && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build && openclaw doctor --fix && openclaw gateway install --force && openclaw gateway start`,
  ].join("\n");
}

/** The checkout a release worktree was added from (`.git` names `<checkout>/.git/worktrees/<id>`). */
function readWorktreeCheckout(root: string): string | null {
  try {
    const gitdir = /^gitdir: (.+)$/mu.exec(fs.readFileSync(path.join(root, ".git"), "utf8"))?.[1];
    return gitdir ? path.dirname(path.dirname(path.dirname(gitdir.trim()))) : null;
  } catch {
    return null;
  }
}
