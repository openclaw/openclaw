import fs from "node:fs/promises";
import path from "node:path";
import { GIT_RELEASE_LAUNCHER, GIT_RELEASE_TRIAL } from "./git-release-paths.js";

export type GitReleaseTrial = {
  /** Link text of the release on trial. */
  target: string;
  /** Link text to switch back to after two failed starts. */
  previous: string;
  /** The trial release's version; state it upgraded keeps `<file>.pre-<version>`. */
  version: string;
  createdAt: number;
  attempts: number;
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

function restoreState(dir, suffix, since, depth) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !["git-install", "npm", "node_modules", "tmp", "logs"].includes(entry.name)) {
        restoreState(file, suffix, since, depth - 1);
      }
    } else if (entry.name.endsWith(suffix) && fs.statSync(file).ctimeMs >= since) {
      fs.renameSync(file, file.slice(0, -suffix.length));
    }
  }
}

let trial;
try {
  trial = JSON.parse(fs.readFileSync(trialFile, "utf8"));
} catch {}
if (trial && counts) {
  if (fs.readlinkSync(slot) !== trial.target) {
    fs.rmSync(trialFile, { force: true });
  } else if (trial.attempts >= 2) {
    const temporary = path.join(path.dirname(slot), ".openclaw.release-link-" + process.pid + "-" + Date.now());
    fs.symlinkSync(trial.previous, temporary);
    fs.renameSync(temporary, slot);
    const suffix = ".pre-" + trial.version;
    restoreState(path.dirname(prefix), suffix, trial.createdAt, 4);
    const config = process.env.OPENCLAW_CONFIG_PATH;
    if (config && fs.existsSync(config + suffix) && fs.statSync(config + suffix).ctimeMs >= trial.createdAt) {
      fs.renameSync(config + suffix, config);
    }
    fs.rmSync(trialFile, { force: true });
    console.error("openclaw: release " + trial.target + " failed to start twice; switched back to " + trial.previous);
  } else {
    const temporary = trialFile + "." + process.pid;
    fs.writeFileSync(temporary, JSON.stringify({ ...trial, attempts: trial.attempts + 1 }));
    fs.renameSync(temporary, trialFile);
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
