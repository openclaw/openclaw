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

/** The link as a double-quoted shell word, plus a guard for the start of the line. The early
 * updater replaces the state and home directories in this check's output with placeholders, so
 * the path is spelled from `$HOME`, or for a state directory outside it from `$OPENCLAW_STATE_DIR`,
 * which the line then requires before it changes anything. That output also redacts `$` followed
 * by 16 or more name characters as a Matrix event ID, so longer names are written `${NAME}` and
 * the line's own variable is short. */
function shellEarlyReleaseLink(
  stateDir: string,
  env: NodeJS.ProcessEnv,
): { link: string; guard?: string } {
  const home = env.HOME?.trim();
  const relative = home ? path.relative(home, stateDir) : "";
  const tail = EARLY_RELEASE_LINK.join("/");
  if (home && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    const spelled = relative
      .split(path.sep)
      .join("/")
      .replace(/["$`\\]/gu, "\\$&");
    return { link: `"$HOME/${spelled}/${tail}"` };
  }
  return {
    link: `"${STATE_DIR_WORD}/${tail}"`,
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
  const { link, guard } = shellEarlyReleaseLink(stateDir, env);
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

/** The state store's and the oldest agent store's schema versions; null when unreadable or
 * PostgreSQL-backed. */
function readSchemaVersions(
  env: NodeJS.ProcessEnv,
): { state: number; agent: number | null } | null {
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
    let agent: number | null = null;
    for (const file of [...agentPaths].filter((candidate) => fs.existsSync(candidate))) {
      const store = open(file);
      try {
        const version = readSqliteUserVersion(store);
        if (version === 0) {
          return null;
        }
        agent = agent === null ? version : Math.min(agent, version);
      } finally {
        store.close();
      }
    }
    return { state, agent };
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
 * run first and cannot be patched, so this release refuses here, before anything changes, and
 * names the one-time rebuild. Same-schema updates through them pass. Returns null for every
 * other caller, and when state is current, newer, unreadable or PostgreSQL-backed.
 *
 * Remove only on evidence that the updaters identified here can cross this hop (a run in which
 * one completes a schema-changing update without this check), not on a date or a release: a
 * published release does not replace the updater these checkouts run. The layout test costs a
 * few path lookups for every other caller, so keeping it is cheap.
 */
export function refuseEarlyGitReleaseSchemaChange(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!isEarlyGitReleaseLayout(root, env)) {
    return null;
  }
  const versions = readSchemaVersions(env);
  const changes: string[] = [];
  if (versions && versions.state < OPENCLAW_STATE_SCHEMA_VERSION) {
    changes.push(`state schema ${versions.state} to ${OPENCLAW_STATE_SCHEMA_VERSION}`);
  }
  if (versions && versions.agent !== null && versions.agent < OPENCLAW_AGENT_SCHEMA_VERSION) {
    changes.push(`agent schema ${versions.agent} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
  }
  if (changes.length === 0) {
    return null;
  }
  return [
    `OpenClaw ${VERSION} migrates your databases (${changes.join(", ")}).`,
    "The updater in this checkout (a main build from 2026-11-17 to 2026-11-19) cannot finish that: after the migration, neither it nor the checkout's `openclaw` command can open the migrated data.",
    "The update stopped before switching releases; the Gateway was not touched. Running `openclaw update` again stops here the same way.",
    ...formatRebuild(platform, resolveStateDir(env), env),
  ].join("\n");
}
