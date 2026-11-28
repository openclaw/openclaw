import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Exact frozen source from d44f2632c4a7d51190368a019f639d697b747ae6,
// src/infra/git-release-launcher.ts (only GIT_RELEASE_TRIAL interpolated).
export const legacyLauncherSource = fs.readFileSync(
  new URL("../../test/fixtures/update/legacy-git-launcher-d44f263.txt", import.meta.url),
  "utf8",
);

export function createLegacyLauncherFixture(state: string) {
  const prefix = path.join(state, "git-install");
  for (const id of ["previous", "candidate"]) {
    const root = path.join(prefix, "releases", id, "openclaw");
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    // The subprocess tests the frozen executable, not the inner CLI or a service.
    for (const entry of ["index.js", "entry.js"]) {
      fs.writeFileSync(path.join(root, "dist", entry), "console.log('diagnostic fixture');\n");
    }
  }
  const target = "releases/candidate/openclaw";
  const slot = path.join(prefix, "openclaw");
  fs.symlinkSync(path.resolve(prefix, target), slot, "junction");
  const launcher = path.join(prefix, "openclaw-launcher.mjs");
  fs.writeFileSync(launcher, legacyLauncherSource);
  const trial = path.join(prefix, "releases", ".trial");
  const record = JSON.stringify({
    target: fs.readlinkSync(slot),
    previous: path.resolve(prefix, "releases/previous/openclaw"),
    version: "2026.11.7",
    createdAt: Date.now(),
    attempts: 0,
  });
  fs.writeFileSync(trial, record);
  return { prefix, root: path.join(prefix, target), slot, launcher, trial, record };
}

export function runLegacyLauncher(launcher: string, args: string[]) {
  return spawnSync(process.execPath, [launcher, ...args], {
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 5_000,
  });
}
