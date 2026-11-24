import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_VALUE_FLAGS } from "../../cli-root-options.mjs";
import { GATEWAY_RUN_VALUE_FLAGS } from "../../gateway-run-argv.mjs";
import {
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "../daemon/windows-task-supervisor-contract.js";
import { LINK_SOURCE } from "../update/link-source.js";
import { ROLLBACK_SOURCE } from "../update/rollback-source.js";
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
  /** Selected by the next service start instead of now (`--no-restart`). */
  pending?: boolean;
  /** Written by the launcher before it restores anything: what the rollback restores. */
  restoring?: Array<{ suffix: string; files: string[] }>;
};

// Frozen contract: the release link, the trial record, and in each release `dist/index.js` (a
// Gateway run) and `dist/entry.js` (every other command). It must not import from any release: a
// release that fails to load is exactly what it recovers from. Writes during a failed trial are
// lost (accepted).
const LAUNCHER_SOURCE = String.raw`#!/usr/bin/env node
// OpenClaw release launcher, written by openclaw update. Services and the CLI on PATH run this file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const prefix = path.dirname(fileURLToPath(import.meta.url));
const slot = path.join(prefix, "openclaw");
const trialFile = path.join(prefix, "releases", "${GIT_RELEASE_TRIAL}");
// Only a Gateway run is a start: "openclaw gateway" or "openclaw gateway run", never another
// "gateway" subcommand. The Windows task supervisor only starts the Gateway child, through this
// launcher (it reads the global below), so only the child's starts count. During a trial the
// supervisor runs the trial's previous release: a trial release that fails to load must not take
// the supervisor down with it, since Task Scheduler does not restart a task whose action exits
// with an error, and the supervisor's crash restarts of the child are what count the starts that
// switch back. An unknown value flag
// can make a start look like a subcommand; it is then not counted (accepted). The launcher knows
// only its own state directory: a run for another profile through this install's PATH entry
// ("openclaw --profile x gateway") counts as this install's start (accepted, Ayaan 2026-11-20).
const valueFlags = new Set(${JSON.stringify([...ROOT_VALUE_FLAGS, ...GATEWAY_RUN_VALUE_FLAGS, WINDOWS_TASK_SUPERVISOR_CHILD_FLAG])});
// As the CLI's command-path parser: after "--" every argument is a literal positional.
const positionals = [];
let literal = false;
let informational = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (literal || !arg.startsWith("-")) {
    positionals.push(arg);
  } else if (arg === "--") {
    literal = true;
  } else if (valueFlags.has(arg)) {
    i++;
  } else if (["-h", "--help", "-V", "--version"].includes(arg)) {
    // Help and version requests only print, so they never select a release or count.
    informational = true;
  }
}
const gatewayRun =
  !informational &&
  positionals[0] === "gateway" &&
  (positionals.length === 1 || (positionals.length === 2 && positionals[1] === "run"));
const supervisor = process.argv.includes("${WINDOWS_TASK_SUPERVISOR_FLAG}");
const counts = gatewayRun && !supervisor;
globalThis[Symbol.for("openclaw.gitReleaseLauncher")] = fileURLToPath(import.meta.url);

// Upgraded state keeps each replaced file as "<file>.pre-<generation>". Restore them
// together: a trial's WAL, journal, SHM or seal must never pair with a restored
// database, so a companion with no preserved predecessor is removed.

function writeTrial(record) {
  const temporary = trialFile + "." + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(record));
  fs.renameSync(temporary, trialFile);
}

// The trial's upgrade plans (owned by src/state/state-upgrade.ts): an interrupted one
// ("<stateDir>/.upgrade-<generation>-*/plan.json") would be finished by the previous release,
// and an applied one (".upgraded-<generation>.json") names files it added with no
// predecessor. Undo those additions and retire both; the suffix restore covers the rest.
${ROLLBACK_SOURCE}

${LINK_SOURCE}

function linked(target) {
  return path.resolve(path.dirname(slot), target);
}

finishSwitch();

let trial;
try {
  trial = JSON.parse(fs.readFileSync(trialFile, "utf8"));
} catch {}
// A deferred npm-to-Git switch still has the package that served as its fallback. Keep
// that trial when the operator starts it; older Git targets that cannot settle their
// own trial retain the existing deferred-release behavior.
if (trial?.pending && counts) {
  if (linked(fs.readlinkSync(slot)) === linked(trial.previous)) {
    switchLink(trial.target);
  }
  // A deferred conversion left the 7db69bedeab6-era link on the old release; it now follows.
  const legacySlot = path.join(prefix, "lib", "node_modules", "openclaw");
  if (fs.lstatSync(legacySlot, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const temporary = legacySlot + ".follow-" + process.pid;
    const followText = process.platform === "win32" ? slot : path.relative(path.dirname(legacySlot), slot);
    fs.symlinkSync(followText, temporary, "junction");
    if (process.platform === "win32") {
      fs.rmSync(legacySlot, { force: true });
    }
    fs.renameSync(temporary, legacySlot);
  }
  if (!linked(trial.previous).startsWith(path.join(prefix, "releases") + path.sep)) {
    trial.pending = false;
    writeTrial(trial);
  } else {
    fs.rmSync(trialFile, { force: true });
    trial = undefined;
  }
}
if (trial && counts) {
  if (linked(fs.readlinkSync(slot)) !== linked(trial.target)) {
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
      for (const generation of [trial.buildId, trial.version].filter(Boolean)) {
        retirePlans(path.dirname(prefix), generation);
        const suffix = ".pre-" + generation;
        const files = collectPreserved(path.dirname(prefix), suffix, since, 4, []);
        const config = trial.config;
        if (config && !files.includes(config) && (fs.lstatSync(config + suffix, { throwIfNoEntry: false })?.ctimeMs ?? 0) >= since) {
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
// The Windows task supervisor starts each Gateway child with process.argv[1] (older builds) or
// the global above, so argv[1] stays on this launcher: every child is counted and selects a
// pending release. On a live trial the supervisor itself runs the fallback release. Its entry
// still sees itself as the main module through pm_exec_path (src/infra/is-main.ts).
const supervisorEntry =
  supervisor && gatewayRun
    ? path.join(
        trial && !trial.pending && linked(fs.readlinkSync(slot)) === linked(trial.target)
          ? linked(trial.previous)
          : slot,
        "dist",
        "index.js",
      )
    : undefined;
if (supervisorEntry) {
  process.env.pm_exec_path = supervisorEntry;
  process.argv[1] = fileURLToPath(import.meta.url);
} else {
  process.argv[1] = path.join(slot, "dist", gatewayRun ? "index.js" : "entry.js");
}
await import(pathToFileURL(supervisorEntry ?? process.argv[1]).href);
`;

export async function writeGitReleaseLauncher(prefix: string): Promise<string> {
  const launcher = path.join(prefix, GIT_RELEASE_LAUNCHER);
  const current = await fs.readFile(launcher, "utf8").catch(() => null);
  // PR1 keeps legacy callers, but they cannot replace the resident supervisor with format 1.
  const format = current?.match(/^\/\/ OpenClaw launcher format: (\d+)$/m);
  if (format && Number(format[1]) >= 2) {
    return launcher;
  }
  if (current !== LAUNCHER_SOURCE) {
    const temporary = `${launcher}.${process.pid}`;
    await fs.writeFile(temporary, LAUNCHER_SOURCE, { mode: 0o755 });
    await fs.rename(temporary, launcher);
  }
  return launcher;
}
