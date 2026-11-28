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

/** The early updater's release link, relative to the state directory. Its launcher serves the
 * release this link names, and `openclaw gateway install` binds the service to that launcher
 * while the link exists, so the rebuild removes it before reinstalling the service. */
const EARLY_RELEASE_LINK = ["git-install", "lib", "node_modules", "openclaw"];
const STATE_DIR_WORD = "${OPENCLAW_STATE_DIR}";

/** A path in the state directory as a double-quoted shell word, plus a guard for the start of a
 * line. The early updater replaces the state and home directories in this check's output with
 * placeholders, so the path is spelled from `$HOME`, or for a state directory outside it from
 * `$OPENCLAW_STATE_DIR`, which the line then requires before it changes anything. That output
 * also redacts `$` followed by 16 or more name characters as a Matrix event ID, so longer names
 * are written `${NAME}` and the line's own variable is short. */
export function shellStatePath(
  stateDir: string,
  env: NodeJS.ProcessEnv,
  tail: string,
): { path: string; guard?: string } {
  const home = env.HOME?.trim();
  const relative = home ? path.relative(home, stateDir) : "";
  if (home && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const spelled = relative
      .split(path.sep)
      .join("/")
      .replace(/["$`\\]/gu, "\\$&");
    return { path: `"$HOME/${spelled}/${tail}"` };
  }
  return {
    path: `"${STATE_DIR_WORD}/${tail}"`,
    guard: ': "${OPENCLAW_STATE_DIR:?set it to the OpenClaw state directory}"',
  };
}

/** The one-time rebuild, run from the checkout. On POSIX shells (proven with systemd and launchd
 * services) it is one line. A failed step puts the release link back if the line had removed it,
 * starts the previous service again and still exits non-zero; running the line again finishes a
 * rebuild that stopped part way. */
function formatRebuild(platform: NodeJS.Platform, stateDir: string, env: NodeJS.ProcessEnv) {
  const build = [
    "git pull --ff-only",
    "openclaw gateway stop --force",
    "pnpm install --frozen-lockfile",
    "pnpm build",
  ];
  const install = "openclaw gateway install --force";
  if (platform === "win32") {
    return [
      `Rebuild the checkout once from its directory, running these in order and stopping at the first failure (if one fails, run \`openclaw gateway start\`), then remove the link ${EARLY_RELEASE_LINK.join("\\")} in the OpenClaw state directory and run \`${install}\`; later updates then run normally:`,
      ...build,
    ];
  }
  const { path: link, guard } = shellStatePath(stateDir, env, EARLY_RELEASE_LINK.join("/"));
  // The previous service may start through this link, so a failure after its removal restores it.
  const saved = "oc_link";
  const steps = [
    ...(guard ? [guard] : []),
    `${saved}=`,
    ...build,
    `${saved}=$(readlink ${link} || true)`,
    `rm -f ${link}`,
    install,
  ];
  const restore = `[ -z "$${saved}" ] || [ -L ${link} ] || ln -s "$${saved}" ${link}`;
  return [
    "Rebuild the checkout once from its directory. It also removes this updater's release link, so the reinstalled Gateway runs the rebuilt checkout; later updates then run normally:",
    `${steps.join(" && ")} || { ${restore}; openclaw gateway start; false; }`,
  ];
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

/** Every SQLite store's schema version, by path. */
export type SchemaVersions = { state: number; agents: Record<string, number> };

/** Every store's schema version; null when unreadable or PostgreSQL-backed. The recovery runner
 * compares these before it puts the previous build back. */
export function readSchemaVersions(env: NodeJS.ProcessEnv = process.env): SchemaVersions | null {
  const stateDir = resolveStateDir(env);
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
    let state: number;
    const db = open(shared);
    try {
      // A PostgreSQL store keeps a version-0 SQLite anchor; its schema lives on the server and
      // migrates through Doctor with writers stopped, which neither the recovery nor the rebuild
      // covers.
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
    const agents: Record<string, number> = {};
    for (const file of [...agentPaths].filter((candidate) => fs.existsSync(candidate))) {
      const store = open(file);
      try {
        const version = readSqliteUserVersion(store);
        if (version === 0) {
          return null;
        }
        agents[file] = version;
      } finally {
        store.close();
      }
    }
    return { state, agents };
  } catch {
    return null;
  }
}

/** Whether this release runs from `<stateDir>/git-install/releases/<id>/build` beside the link
 * `git-install/lib/node_modules/openclaw`, the layout only the early updater builds. */
function isEarlyGitReleaseLayout(root: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const prefix = fs.realpathSync(path.join(resolveStateDir(env), "git-install"));
    const real = fs.realpathSync(root);
    const releases = path.dirname(path.dirname(real));
    return (
      path.basename(real) === "build" &&
      path.basename(releases) === "releases" &&
      path.dirname(releases) === prefix &&
      fs.lstatSync(path.join(prefix, "lib", "node_modules", "openclaw")).isSymbolicLink()
    );
  } catch {
    return false;
  }
}

export type EarlyGitReleaseSchemaChange = {
  root: string;
  stateDir: string;
  /** `<stateDir>/git-install`, resolved. */
  prefix: string;
  /** What this release would migrate (`agent`: the oldest agent store, if any); null once an
   * automatic recovery started by an earlier update migrated it. */
  pending: { state: number; agent: number | null } | null;
};

/**
 * Updaters built from `main` between #199706 (6747b1ec5ae, 2026-11-17) and #201917
 * (2ef6f7bade7, 2026-11-19) build each Git release in `<stateDir>/git-install/releases/<id>/build`
 * behind the link `git-install/lib/node_modules/openclaw`, and run this release's `--check`
 * there (`checkUpdateCandidate`) before they switch that link. No other updater builds a release
 * at that path.
 *
 * They cannot finish an update that changes a database schema. They never rebuild the checkout,
 * so after a migration neither the updater's own process nor the checkout's `openclaw` can open
 * the data; builds before #201463 (2183caf789c) even require the migrated schema before the
 * restart that would migrate it, fail after switching the link, and leave the install
 * half-switched, so their next run reports the never-started release as current. Those updaters
 * run first and cannot be patched, so this release stops them here, before anything changes:
 * `update-early-release-recovery-start.ts` then finishes the update where it can, and otherwise
 * the refusal names the one-time rebuild. It also stops them while that recovery's release
 * exists, because state it already migrated would let a concurrent early updater through.
 * Same-schema updates through them pass. Returns null for every other caller, and when state is
 * current, newer, unreadable or PostgreSQL-backed.
 *
 * Remove only on evidence that no installed updater identified here still needs it (a run in
 * which one completes a schema-changing update without this check, or none left on the
 * updater's 2026-11-17 to 2026-11-19 commits), not on a date or a release: a published release
 * does not replace the updater these checkouts run. The layout test costs a few path lookups for
 * every other caller, so keeping it is cheap. Remove the recovery modules with it.
 */
export function inspectEarlyGitReleaseSchemaChange(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): EarlyGitReleaseSchemaChange | null {
  if (!isEarlyGitReleaseLayout(root, env)) {
    return null;
  }
  const stateDir = resolveStateDir(env);
  const prefix = fs.realpathSync(path.join(stateDir, "git-install"));
  const versions = readSchemaVersions(env);
  const agents = versions ? Object.values(versions.agents) : [];
  const agent = agents.length > 0 ? Math.min(...agents) : null;
  const pending =
    versions &&
    (versions.state < OPENCLAW_STATE_SCHEMA_VERSION ||
      (agent !== null && agent < OPENCLAW_AGENT_SCHEMA_VERSION))
      ? { state: versions.state, agent }
      : null;
  return pending || fs.existsSync(path.join(prefix, "recovery"))
    ? { root, stateDir, prefix, pending }
    : null;
}

/** How the recovery a check started, or found running, is followed. */
type EarlyGitReleaseRecoveryJob = { status: string; log: string };

export type EarlyGitReleaseRecoveryStart =
  | { started: true; job: EarlyGitReleaseRecoveryJob; target: string }
  | { started: false; running?: EarlyGitReleaseRecoveryJob; reason?: string };

/** The check's stderr, which the early updater prints with state and home paths redacted. */
export function formatEarlyGitReleaseRefusal(
  change: EarlyGitReleaseSchemaChange,
  recovery: EarlyGitReleaseRecoveryStart,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const { pending } = change;
  const changes = pending
    ? [
        ...(pending.state < OPENCLAW_STATE_SCHEMA_VERSION
          ? [`state schema ${pending.state} to ${OPENCLAW_STATE_SCHEMA_VERSION}`]
          : []),
        ...(pending.agent !== null && pending.agent < OPENCLAW_AGENT_SCHEMA_VERSION
          ? [`agent schema ${pending.agent} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`]
          : []),
      ]
    : [];
  const lines = pending
    ? [
        `OpenClaw ${VERSION} migrates your databases (${changes.join(", ")}).`,
        "The updater in this checkout (a main build from 2026-11-17 to 2026-11-19) cannot finish that: after the migration, neither it nor the checkout's `openclaw` command can open the migrated data.",
      ]
    : [
        "An automatic recovery that an earlier update started has migrated your databases; the updater in this checkout cannot run another update.",
      ];
  const job = recovery.started ? recovery.job : recovery.running;
  if (job) {
    return [
      ...lines,
      recovery.started
        ? `So it stops here and reports this update as failed, and the new release finishes the update in the background. In about 5 to 10 minutes it moves the checkout to ${recovery.target.slice(0, 11)}, restarts the Gateway on the new release (which migrates your databases at startup), rebuilds the checkout while that release serves, and restarts the Gateway on the rebuilt checkout. The first restart lasts as long as the migration; the second takes a few seconds. If the new release does not start before migrating, the previous build is put back. If the recovery cannot finish, the Gateway keeps serving and its log says why and names the one command that finishes the update; \`openclaw update status\` shows the outcome.`
        : "So it stops here. That recovery is still running and finishes the update; nothing else was changed.",
      "Until the rebuild finishes, the checkout's `openclaw` command may fail or refuse the migrated data; that is expected.",
      `Follow progress: ${job.status} (log: ${job.log})`,
    ].join("\n");
  }
  return [
    ...lines,
    "The update stopped before switching releases; the Gateway was not touched. Running `openclaw update` again stops here the same way.",
    ...(!recovery.started && recovery.reason
      ? [`Automatic recovery did not start: ${recovery.reason}.`]
      : []),
    ...formatRebuild(platform, change.stateDir, env),
  ].join("\n");
}
