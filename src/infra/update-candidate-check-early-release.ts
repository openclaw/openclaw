import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db-contract.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import { resolveUserPath } from "./home-dir.js";
import {
  openNodeSqliteDatabase,
  resolveImmutableSqliteFileUri,
  resolveReadOnlyShmSqliteFileUri,
} from "./node-sqlite.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { collectRegisteredPaths } from "./update-candidate-state.shared.js";

/** The one-time rebuild, run from the checkout. It names no path, because the early updater
 * redacts the state and home directories out of this check's output before printing it. */
const EARLY_GIT_RELEASE_REBUILD =
  "git pull --ff-only && openclaw gateway stop --force && pnpm install --frozen-lockfile && pnpm build && openclaw gateway install --force || { openclaw gateway start; false; }";

export type EarlyGitReleaseSchemaChange = {
  root: string;
  stateDir: string;
  /** `<stateDir>/git-install`, resolved. */
  prefix: string;
  /** What this release would migrate (`agent`: the oldest agent store, if any); null once an
   * automatic recovery started by an earlier update migrated it. */
  pending: { state: number; agent: number | null } | null;
};

/** Every SQLite store's schema version, by path; null when unreadable or PostgreSQL-backed. */
export type SchemaVersions = { state: number; agents: Record<string, number> };

/** On-disk schema versions when this build would migrate them; null when current or unreadable. */
function readPendingSchemaChange(
  env: NodeJS.ProcessEnv = process.env,
): { state: number; agent: number | null } | null {
  const versions = readSchemaVersions(env);
  if (!versions) {
    return null;
  }
  const agents = Object.values(versions.agents);
  const agent = agents.length > 0 ? Math.min(...agents) : null;
  if (
    versions.state >= OPENCLAW_STATE_SCHEMA_VERSION &&
    !(agent !== null && agent < OPENCLAW_AGENT_SCHEMA_VERSION)
  ) {
    return null;
  }
  return { state: versions.state, agent };
}

/** The header's read and write format versions are 2 for a WAL database. */
function isClosedWalStore(file: string): boolean {
  const header = Buffer.alloc(20);
  const fd = fs.openSync(file, "r");
  try {
    return fs.readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2 && header[19] === 2;
  } finally {
    fs.closeSync(fd);
  }
}

export function readSchemaVersions(env: NodeJS.ProcessEnv = process.env): SchemaVersions | null {
  const stateDir = resolveStateDir(env);
  let state: number;
  const agents: Record<string, number> = {};
  try {
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
    // readonly_shm reads committed WAL content without touching the serving Gateway's sidecars;
    // it cannot open a WAL store a stopped Gateway closed (no -wal), whose file is then whole.
    // A rollback-journal store (network filesystems) has no -wal while live: it is read with
    // locks, which wait out a writer's commit and see a hot -journal.
    const open = (file: string) => {
      if (fs.existsSync(`${file}-wal`)) {
        return openNodeSqliteDatabase(resolveReadOnlyShmSqliteFileUri(file), { readOnly: true });
      }
      if (!fs.existsSync(`${file}-journal`) && isClosedWalStore(file)) {
        return openNodeSqliteDatabase(resolveImmutableSqliteFileUri(file), { readOnly: true });
      }
      return openNodeSqliteDatabase(file, {
        readOnly: true,
        timeout: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
    };
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
        agents[file] = version;
      } finally {
        agent.close();
      }
    }
  } catch {
    return null;
  }
  return { state, agents };
}

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
 * (`update-early-release-recovery.ts` then finishes the update where it can). It also refuses
 * while that recovery's release exists, because state it already migrated would let a concurrent
 * early updater through. Other same-schema updates pass through. Returns null for every other
 * caller and when state is current or unreadable.
 *
 * Remove once no install can still run an updater from that window.
 */
export function inspectEarlyGitReleaseSchemaChange(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): EarlyGitReleaseSchemaChange | null {
  const stateDir = resolveStateDir(env);
  let prefix: string;
  try {
    prefix = fs.realpathSync(path.join(stateDir, "git-install"));
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
  } catch {
    return null;
  }
  const pending = readPendingSchemaChange(env);
  return pending || fs.existsSync(path.join(prefix, "recovery"))
    ? { root, stateDir, prefix, pending }
    : null;
}

export type EarlyGitReleaseRecoveryStart =
  | { started: true; unit: string; target: string }
  | { started: false; running?: string; reason?: string };

/** The check's stderr, which the early updater prints with state and home paths redacted. */
export function formatEarlyGitReleaseRefusal(
  change: EarlyGitReleaseSchemaChange,
  recovery: EarlyGitReleaseRecoveryStart,
): string {
  const { pending } = change;
  const lines = pending
    ? [
        `OpenClaw ${VERSION} migrates your databases (state schema ${pending.state} to ${OPENCLAW_STATE_SCHEMA_VERSION}${
          pending.agent === null
            ? ""
            : `, agent schema ${pending.agent} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`
        }).`,
        "The updater in this checkout (a main build from 2026-11-17 to 2026-11-19) cannot finish that: after the migration, neither it nor the checkout's `openclaw` command can open the migrated data.",
      ]
    : [
        "An automatic recovery that an earlier update started has migrated your databases; the updater in this checkout cannot run another update.",
      ];
  const unit = recovery.started ? recovery.unit : recovery.running;
  if (unit) {
    return [
      ...lines,
      recovery.started
        ? `So it stops here and reports this update as failed, and the new release finishes the update in the background. In about 5 to 10 minutes it moves the checkout to ${recovery.target.slice(0, 11)}, restarts the Gateway on the new release (which migrates your databases at startup), rebuilds the checkout, and restarts the Gateway on the rebuilt checkout. The first restart lasts as long as the migration; the second takes a few seconds. If the new release does not start before migrating, it puts the previous build back. If it cannot finish, its log (journalctl --user -u ${unit}) says why and prints the next step; \`openclaw update status\` shows the outcome once the checkout is rebuilt.`
        : "So it stops here. That recovery is still running and finishes the update; nothing else was changed.",
      "Until the rebuild finishes, the checkout's `openclaw` command may fail or refuse the migrated data; that is expected.",
      `Follow progress: systemctl --user status ${unit} (log: journalctl --user -u ${unit})`,
    ].join("\n");
  }
  return [
    ...lines,
    "The update stopped before switching releases; the Gateway was not touched.",
    ...(!recovery.started && recovery.reason
      ? [`Automatic recovery did not start: ${recovery.reason}.`]
      : []),
    "Rebuild the checkout once from its directory; later updates then run normally:",
    EARLY_GIT_RELEASE_REBUILD,
  ].join("\n");
}
