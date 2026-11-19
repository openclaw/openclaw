import fs from "node:fs/promises";
import path from "node:path";
import { GIT_RELEASE_LAUNCHER, GIT_RELEASE_TRIAL } from "./git-release-paths.js";

export type GitReleaseTrial = {
  /** Link text of the release on trial. */
  target: string;
  /** Link text to switch back to after two failed starts. */
  previous: string;
  /** The trial release's version; state upgraded by builds without a build ID keeps `<file>.pre-<version>`. */
  version: string;
  /** The trial release's build ID; state its upgrade replaced keeps `<file>.pre-<buildId>`. */
  buildId?: string;
  createdAt: number;
  attempts: number;
  /** The resolved config path; a config outside the state directory is not in the scan. */
  config?: string;
  /** Selected by the next service start instead of now (`--no-restart`), without a fallback. */
  pending?: boolean;
  /** Written by the launcher before it restores anything: what the rollback restores. */
  restoring?: Array<{ suffix: string; files: string[] }>;
};

// Frozen contract: the release link, the trial record and `dist/index.js` in each
// release. It must not import from any release: a release that fails to load is
// exactly what it recovers from. Writes during a failed trial are lost (accepted).
const LAUNCHER_SOURCE = String.raw`#!/usr/bin/env node
// OpenClaw release launcher, written by openclaw update. The service runs this file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const prefix = path.dirname(fileURLToPath(import.meta.url));
const slot = path.join(prefix, "lib", "node_modules", "openclaw");
const trialFile = path.join(prefix, "releases", "${GIT_RELEASE_TRIAL}");
const counts = process.argv.slice(2).includes("gateway");

// Upgraded state keeps each replaced file as "<file>.pre-<generation>". Restore them
// together: a trial's WAL, journal, SHM or seal must never pair with a restored
// database, so a companion with no preserved predecessor is removed.
function collectPreserved(dir, suffix, since, depth, found) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !["git-install", "npm", "node_modules", "tmp", "logs"].includes(entry.name)) {
        collectPreserved(file, suffix, since, depth - 1, found);
      }
    } else if (entry.name.endsWith(suffix) && fs.lstatSync(file).ctimeMs >= since) {
      found.push(file.slice(0, -suffix.length));
    }
  }
  return found;
}

function restoreState(files, suffix) {
  const restored = new Set(files);
  for (const file of files) {
    for (const companion of ["-wal", "-journal", "-shm", ".seal"]) {
      if (!restored.has(file + companion)) {
        fs.rmSync(file + companion, { force: true });
      }
    }
  }
  for (const file of files) {
    if (fs.existsSync(file + suffix)) {
      fs.renameSync(file + suffix, file);
    }
  }
}

function writeTrial(record) {
  const temporary = trialFile + "." + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(record));
  fs.renameSync(temporary, trialFile);
}

// The trial's upgrade records (owned by src/state/state-upgrade.ts): an interrupted one
// ("<stateDir>/.upgrade-<generation>-*", with plan.json once its swap is durable) would be
// finished by the previous release, and an applied one (".upgraded-<generation>.json") names
// files it added with no predecessor. A revert removes those additions and retires both;
// the suffix restore covers the rest.
function plannedAdditions(stateDir, generation) {
  const added = [];
  const applied = path.join(stateDir, ".upgraded-" + generation + ".json");
  let record;
  try {
    record = JSON.parse(fs.readFileSync(applied, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  for (const op of record?.ops ?? []) {
    if (op.kind === "add") {
      added.push(op.live);
    }
  }
  const interrupted = [];
  for (const entry of fs.readdirSync(stateDir)) {
    if (!entry.startsWith(".upgrade-" + generation + "-")) {
      continue;
    }
    const dir = path.join(stateDir, entry);
    interrupted.push(dir);
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    } catch {}
    for (const op of plan?.ops ?? []) {
      if (op.kind === "add") {
        added.push(op.live);
      }
    }
  }
  return { added, applied: record ? applied : undefined, interrupted };
}

function retirePlans(stateDir, generation) {
  const { added, applied, interrupted } = plannedAdditions(stateDir, generation);
  // A failed removal propagates and keeps the records, so the next start retries.
  for (const file of added) {
    fs.rmSync(file, { force: true });
  }
  if (applied) {
    fs.rmSync(applied, { force: true });
  }
  for (const dir of interrupted) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A revert must land only on a build that opens the state it leaves, and only on positive
// evidence: the previous release names the schemas it opens in its own package.json, and
// each database the revert leaves (the image it restores, else the live file; never one
// the revert removes) is read the way that release admits it: the header, and for shared
// state also its content version. Anything that cannot be read keeps the service forward.
async function revertBlockers(stateDir, previous, restoring, generations, config) {
  const restoredFrom = new Map();
  for (const { suffix, files } of restoring) {
    for (const file of files) {
      if (fs.existsSync(file + suffix)) {
        restoredFrom.set(file, file + suffix);
      }
    }
  }
  let supported;
  try {
    supported = JSON.parse(fs.readFileSync(path.join(path.resolve(path.dirname(slot), previous), "package.json"), "utf8"))?.openclaw?.schemaVersions;
  } catch {}
  if (!Number.isInteger(supported?.state) || !Number.isInteger(supported?.agent)) {
    return [previous + " declares no schema versions"];
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return ["node:sqlite is unavailable to read the state"];
  }
  const removed = new Set();
  let upgraded = restoredFrom.size > 0;
  for (const generation of generations) {
    const planned = plannedAdditions(stateDir, generation);
    planned.added.forEach((file) => removed.add(file));
    upgraded ||= Boolean(planned.applied) || planned.interrupted.length > 0;
  }
  const databases = [[path.join(stateDir, "state", "openclaw.sqlite"), supported.state, true]];
  try {
    for (const agent of fs.readdirSync(path.join(stateDir, "agents"))) {
      databases.push([path.join(stateDir, "agents", agent, "agent", "openclaw-agent.sqlite"), supported.agent, false]);
    }
  } catch {}
  const blockers = [];
  for (const [live, limit, shared] of databases) {
    const file = restoredFrom.get(live) ?? live;
    if (removed.has(live) || !fs.existsSync(file)) {
      continue;
    }
    const name = path.relative(stateDir, live);
    let version;
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        version = db.prepare("PRAGMA user_version").get()?.user_version;
        // Shared-state admission also refuses a newer content version behind an older header.
        if (shared && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'").get()) {
          const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'").get();
          if (row) {
            const content = JSON.parse(row.value_json);
            version = Number.isSafeInteger(content) && content >= 0 ? Math.max(version, content) : undefined;
          }
        }
      } finally {
        db.close();
      }
    } catch {
      version = undefined;
    }
    if (!Number.isSafeInteger(version)) {
      blockers.push("could not read the schema of " + name);
    } else if (version > limit) {
      blockers.push(name + " schema " + version + " (" + previous + " supports " + limit + ")");
    }
  }
  // An upgrade may have rewritten the config; without its image the revert cannot prove it.
  if (upgraded && config && fs.existsSync(config) && !restoring.some(({ files }) => files.includes(config))) {
    blockers.push("the config has no pre-migration image");
  }
  return blockers;
}

function switchLink(target) {
  const temporary = path.join(path.dirname(slot), ".openclaw.release-link-" + process.pid + "-" + Date.now());
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, slot);
}

let trial;
try {
  trial = JSON.parse(fs.readFileSync(trialFile, "utf8"));
} catch {}
// An update run with --no-restart leaves activation to the next service start. That start
// is the operator's, with no updater to settle a trial (an older target cannot settle it
// itself), so a deferred release is selected without the two-start fallback.
if (trial?.pending && counts) {
  if (fs.readlinkSync(slot) === trial.previous) {
    switchLink(trial.target);
  }
  fs.rmSync(trialFile, { force: true });
  trial = undefined;
}
if (trial && counts) {
  if (fs.readlinkSync(slot) !== trial.target) {
    fs.rmSync(trialFile, { force: true });
  } else if (trial.attempts >= 2) {
    // State first, link last: until the link moves, an interrupted rollback reruns here.
    // The trial's build names what it replaced; an older trial build used its version.
    // The inventory is recorded before any rename, so a retry still knows a family's
    // already-restored companions and never removes them as the trial's own.
    if (!trial.restoring) {
      trial.restoring = [];
      // File timestamps come from a coarse kernel clock that can trail Date.now() by a tick.
      const since = trial.createdAt - 1000;
      const generations = [trial.buildId, trial.version].filter(Boolean);
      for (const generation of generations) {
        const suffix = ".pre-" + generation;
        const files = collectPreserved(path.dirname(prefix), suffix, since, 4, []);
        const config = trial.config;
        if (config && !files.includes(config) && (fs.lstatSync(config + suffix, { throwIfNoEntry: false })?.ctimeMs ?? 0) >= since) {
          files.push(config);
        }
        trial.restoring.push({ suffix, files });
      }
      const blockers = await revertBlockers(path.dirname(prefix), trial.previous, trial.restoring, generations, trial.config);
      if (blockers.length > 0) {
        trial.forward = blockers;
      } else {
        // Decided before anything changes: staying forward keeps what the upgrade added.
        for (const generation of generations) {
          retirePlans(path.dirname(prefix), generation);
        }
        writeTrial(trial);
      }
    }
    if (trial.forward) {
      // Nothing proves the previous release opens what a revert would leave: stay forward.
      fs.rmSync(trialFile, { force: true });
      console.error("openclaw: release " + trial.target + " failed to start twice, but switching back is not proven safe: " + trial.forward.join("; ") + ". The service stays on " + trial.target + " rather than revert onto " + trial.previous + ", which may refuse this state. Fix forward: run openclaw triage, or openclaw update once a fixed release is available.");
    } else {
      for (const { suffix, files } of trial.restoring) {
        restoreState(files, suffix);
      }
      switchLink(trial.previous);
      fs.rmSync(trialFile, { force: true });
      console.error("openclaw: release " + trial.target + " failed to start twice; switched back to " + trial.previous);
    }
  } else {
    writeTrial({ ...trial, attempts: trial.attempts + 1 });
  }
}
process.argv[1] = path.join(slot, "dist", "index.js");
await import(pathToFileURL(process.argv[1]).href);
`;

export async function writeGitReleaseLauncher(prefix: string): Promise<string> {
  const launcher = path.join(prefix, GIT_RELEASE_LAUNCHER);
  const current = await fs.readFile(launcher, "utf8").catch(() => null);
  if (current !== LAUNCHER_SOURCE) {
    const temporary = `${launcher}.${process.pid}`;
    await fs.writeFile(temporary, LAUNCHER_SOURCE, { mode: 0o755 });
    await fs.rename(temporary, launcher);
  }
  return launcher;
}
