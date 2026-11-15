import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-release-metadata-only.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingMtsEntrypoints } from "./tooling-mts-runtime.test-support.mts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptArgs = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(toolingMtsEntrypoints.releaseMetadata),
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const itUnix = process.platform === "win32" ? it.skip : it;

describe("check-release-metadata-only", () => {
  it("parses refs and explicit paths", () => {
    const refs = ["--base", "origin/release", "--head", "HEAD"];
    expect(parseArgs([...refs, "./package.json", "apps\\ios\\CHANGELOG.md"])).toEqual({
      staged: false,
      base: "origin/release",
      head: "HEAD",
      paths: ["package.json", "apps/ios/CHANGELOG.md"],
    });
  });

  it("rejects missing ref option values", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("Expected --base <ref>.");
    expect(() => parseArgs(["--base", "-h"])).toThrow("Expected --base <ref>.");
    expect(() => parseArgs(["--head"])).toThrow("Expected --head <ref>.");
    expect(() => parseArgs(["--head", "-h"])).toThrow("Expected --head <ref>.");
    expect(() => parseArgs(["--base", ""])).toThrow("Expected --base <ref>.");
  });

  it("rejects unknown options before treating args as paths", () => {
    expect(() => parseArgs(["--stgaed"])).toThrow("Unknown option: --stgaed");
  });

  it("preserves option-shaped paths after the separator", () => {
    expect(parseArgs(["--staged", "--", "--head"])).toEqual({
      staged: true,
      head: "HEAD",
      paths: ["--head"],
    });
  });

  it("preserves refs, staged bytes, and worktree overlay through the CLI", () => {
    const root = tempDirs.make("openclaw-release-metadata-mobile-");
    const at = (file: string) => path.join(root, file);
    const runMetadata = (args: string[]) =>
      spawnSync(process.execPath, [...scriptArgs, ...args], {
        cwd: root,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json") },
        encoding: "utf8",
      });
    const manifestPath = at("apps/android/version.json");
    const writeVersion = (version: string, channel?: string) =>
      fs.writeFileSync(manifestPath, JSON.stringify({ version, ...(channel ? { channel } : {}) }));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const compareHead = (head = "HEAD") =>
      runMetadata(["--base", head, "--head", head, "--", "apps/android/version.json"]);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeVersion("2026.8.1");
    git("init", "-q");
    git("config", "user.name", "OpenClaw Test");
    git("config", "user.email", "test@openclaw.invalid");
    git("add", "apps/android/version.json");
    git("commit", "-qm", "baseline");

    writeVersion("2026.8.2");
    const accepted = compareHead();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stderr).toContain("[release-metadata] ok (1 files)");

    git("add", "apps/android/version.json");
    writeVersion("2026.8.2", "stable");
    const staged = runMetadata(["--staged"]);
    expect(staged.status, staged.stderr).toBe(0);
    const head = git("rev-parse", "HEAD");
    const pinned = compareHead(head);
    expect(pinned.status, pinned.stderr).toBe(0);
    const rejected = compareHead();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      "apps/android/version.json: changed outside recognized version/build literals",
    );

    // Incoming metadata may legitimately differ from the feature branch's HEAD.
    git("add", "apps/android/version.json");
    git("commit", "-qm", "incoming metadata");
    const incoming = git("rev-parse", "HEAD");
    git("switch", "--detach", head);
    writeVersion("2026.8.3", "stable");
    git("add", "apps/android/version.json");
    const based = runMetadata(["--staged", "--base", incoming]);
    expect(based.status, based.stderr).toBe(0);
    expect(based.stderr).toContain("[release-metadata] ok (1 files)");
    expect(runMetadata(["--staged"]).status).toBe(1);
  });

  itUnix("fails with an actionable timeout when git diff hangs", () => {
    const tempDir = tempDirs.make("openclaw-release-metadata-git-");
    const gitPath = path.join(tempDir, "git");
    fs.writeFileSync(
      gitPath,
      '#!/usr/bin/env node\nif (process.argv.includes("diff")) { setInterval(() => {}, 1000); }\n',
      "utf8",
    );
    fs.chmodSync(gitPath, 0o755);

    const run = (timeout: string) =>
      spawnSync(process.execPath, scriptArgs, {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENCLAW_RELEASE_METADATA_GIT_TIMEOUT_MS: timeout,
          PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 5_000,
      });
    for (const [timeout, diagnostic] of [
      [
        "500",
        "release metadata guard: git diff --name-only --diff-filter=ACMR origin/main...HEAD timed out after 500ms.",
      ],
      ["0.5", "timed out after 1ms."],
    ] as const) {
      expect(run(timeout)).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(diagnostic),
      });
    }
  });
});
