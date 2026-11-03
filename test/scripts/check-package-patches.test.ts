import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectPackagePatchViolations } from "../../scripts/check-package-patches.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv, writeJsonFile } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writePatches(root: string, file: string, patches: readonly (readonly [string, string])[]) {
  const header = file === "pnpm-workspace.yaml" ? "packages:\n  - ." : "lockfileVersion: '9.0'";
  const rows = patches.map(([key, value]) => `  "${key}": "${value}"`);
  fixtureFiles(root).write(file, `${header}\npatchedDependencies:\n${rows.join("\n")}\n`);
}

function violation(file: string, kind: string, detail: string) {
  return { file, kind, detail };
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, env: createNestedGitEnv() });
}

function makeRepo() {
  const dir = tempDirs.make("openclaw-package-patches-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  writeJsonFile(path.join(dir, "package.json"), { name: "fixture" });
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf8");
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  git(dir, ["add", "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]);
  return dir;
}

it("allows approved pnpm patches together", () => {
  const approvedPatches = [
    ["@homebridge/ciao@1.3.12", "patches/@homebridge__ciao@1.3.12.patch"],
    ["proper-lockfile@4.1.2", "patches/proper-lockfile@4.1.2.patch"],
    ["@clawdbot/lobster@2026.10.1", "patches/@clawdbot__lobster@2026.10.1.patch"],
    ["apache-arrow@21.2.0", "patches/apache-arrow@21.2.0.patch"],
    ["@shinyoshiaki/binary-data@0.6.1", "patches/@shinyoshiaki__binary-data@0.6.1.patch"],
    ["@openclaw/crabline@0.1.31", "patches/@openclaw__crabline@0.1.31.patch"],
    ["playwright-core@1.64.1", "patches/playwright-core@1.64.1.patch"],
    ["minizlib@3.1.0", "patches/minizlib@3.1.0.patch"],
    ["tar@7.5.22", "patches/tar@7.5.22.patch"],
    ["baileys@7.0.0-rc12", "patches/baileys@7.0.0-rc12.patch"],
    ["baileys@7.0.0-rc13", "patches/baileys@7.0.0-rc13.patch"],
    ["baileys@7.0.0-rc14", "patches/baileys@7.0.0-rc14.patch"],
    ["vitest@5.0.5", "patches/vitest@5.0.5.patch"],
    ["matrix-js-sdk@43.0.0", "patches/matrix-js-sdk@43.0.0.patch"],
    ["@solidjs/web@2.0.0-rc.18", "patches/@solidjs__web@2.0.0-rc.18.patch"],
    ["@solidjs/signals@2.0.0-rc.18", "patches/@solidjs__signals@2.0.0-rc.18.patch"],
  ] as const;
  const dir = makeRepo();
  const hash = "a9aea1790d2c65b1ae543c77faca4119bbfb91ee3b6ca6c38d1cad4f5702ada2";
  writePatches(dir, "pnpm-workspace.yaml", approvedPatches);
  const hashes = approvedPatches.map(([specifier]) => [specifier, hash] as const);
  writePatches(dir, "pnpm-lock.yaml", hashes);
  for (const [, patchPath] of approvedPatches) {
    fixtureFiles(dir).write(patchPath, "diff\n");
  }
  git(dir, ["add", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches"]);

  expect(collectPackagePatchViolations(dir)).toEqual([]);
});

it.each([
  ["left-pad@1.3.0", "patches/left-pad@1.3.0.patch"],
  ["matrix-js-sdk@42.4.1", "patches/matrix-js-sdk@42.4.1.patch"],
  ["matrix-js-sdk@43.0.0", "patches/matrix-js-sdk@43.0.0-other.patch"],
])("rejects unapproved workspace patch %s -> %s", (specifier, patchPath) => {
  const dir = makeRepo();
  writePatches(dir, "pnpm-workspace.yaml", [[specifier, patchPath]]);
  fixtureFiles(dir).write(patchPath, "diff\n");
  fixtureFiles(dir).write("fixtures/fixture.patch", "diff\n");
  git(dir, ["add", "pnpm-workspace.yaml", "patches", "fixtures"]);

  expect(collectPackagePatchViolations(dir)).toEqual([
    violation("pnpm-workspace.yaml", "patchedDependency", `${specifier} -> ${patchPath}`),
    violation("fixtures/fixture.patch", "patchFile", "new package patch file"),
    violation(patchPath, "patchFile", "new package patch file"),
  ]);
});

it.each([false, true])(
  "rejects lockfile and package-local patches with toolchain metadata %s",
  (withToolchain) => {
    const dir = makeRepo();
    writeJsonFile(path.join(dir, "package.json"), {
      pnpm: { patchedDependencies: { "nested@1.0.0": "patches/nested.patch" } },
    });
    fixtureFiles(dir).write(
      "pnpm-lock.yaml",
      `${withToolchain ? "---\nlockfileVersion: '9.0'\npatchedDependencies:\n  toolchain@1.0.0: toolhash\n---\n" : ""}lockfileVersion: '9.0'
patchedDependencies:
  hidden@1.0.0: abc123
`,
    );
    git(dir, ["add", "package.json", "pnpm-lock.yaml"]);

    expect(collectPackagePatchViolations(dir)).toEqual([
      ...(withToolchain
        ? [violation("pnpm-lock.yaml", "patchedDependency", "toolchain@1.0.0 -> toolhash")]
        : []),
      violation("pnpm-lock.yaml", "patchedDependency", "hidden@1.0.0 -> abc123"),
      violation(
        "package.json",
        "packageJsonPatchedDependency",
        "nested@1.0.0 -> patches/nested.patch",
      ),
    ]);
  },
);

it.each([
  "patches/@agentclientprotocol__claude-agent-acp@0.33.1.patch",
  "packages/deleted/package.json",
])("allows deletion of tracked patch inputs: %s", (file) => {
  const dir = makeRepo();
  writeJsonFile(path.join(dir, file), {
    pnpm: { patchedDependencies: { "deleted-only@1.0.0": "patches/deleted-only.patch" } },
  });
  git(dir, ["add", file]);
  rmSync(path.join(dir, file));

  expect(collectPackagePatchViolations(dir)).toEqual([]);
});
