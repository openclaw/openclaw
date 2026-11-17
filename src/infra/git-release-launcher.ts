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
    } else if (entry.name.endsWith(suffix) && fs.statSync(file).ctimeMs >= since) {
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

// The trial's upgrade plans (owned by src/state/state-upgrade.ts): an interrupted one
// ("<stateDir>/.upgrade-<generation>-*/plan.json") would be finished by the previous release,
// and an applied one (".upgraded-<generation>.json") names files it added with no
// predecessor. Undo those additions and retire both; the suffix restore covers the rest.
function retirePlans(stateDir, generation) {
  const applied = path.join(stateDir, ".upgraded-" + generation + ".json");
  let record;
  try {
    record = JSON.parse(fs.readFileSync(applied, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  // A failed removal propagates and keeps the record, so the next start retries.
  for (const op of record?.ops ?? []) {
    if (op.kind === "add") {
      fs.rmSync(op.live, { force: true });
    }
  }
  fs.rmSync(applied, { force: true });
  for (const entry of fs.readdirSync(stateDir)) {
    if (!entry.startsWith(".upgrade-" + generation + "-")) {
      continue;
    }
    const dir = path.join(stateDir, entry);
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    } catch {}
    for (const op of plan?.ops ?? []) {
      if (op.kind === "add" && op.next && !fs.existsSync(op.next)) {
        fs.rmSync(op.live, { force: true });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
      for (const generation of [trial.buildId, trial.version].filter(Boolean)) {
        retirePlans(path.dirname(prefix), generation);
        const suffix = ".pre-" + generation;
        const files = collectPreserved(path.dirname(prefix), suffix, trial.createdAt, 4, []);
        const config = trial.config;
        if (config && !files.includes(config) && fs.existsSync(config + suffix) && fs.statSync(config + suffix).ctimeMs >= trial.createdAt) {
          files.push(config);
        }
        trial.restoring.push({ suffix, files });
      }
      writeTrial(trial);
    }
    for (const { suffix, files } of trial.restoring) {
      restoreState(files, suffix);
    }
    switchLink(trial.previous);
    fs.rmSync(trialFile, { force: true });
    console.error("openclaw: release " + trial.target + " failed to start twice; switched back to " + trial.previous);
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
