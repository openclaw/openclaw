import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runPackageUpdateDoctor } from "../cli/update-cli/update-command-package.js";
import { resolveCandidateNodeRuntimeForTest } from "./update-runner-git-candidate.test-support.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

export function createGitAdmissionFixture(
  relativeRemote = false,
  partialClone = false,
  shallow = false,
  objectFormat: "sha1" | "sha256" = "sha1",
) {
  const root = temporary.make("openclaw-git-admission-test-");
  const source = path.join(root, "remote with spaces");
  const install = path.join(root, "installed");
  const globalConfig = path.join(root, "empty-config");
  fs.writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH_VARIANT: undefined,
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  fs.mkdirSync(source);
  git(source, "init", "-b", "main", `--object-format=${objectFormat}`);
  git(source, "config", "user.name", "Update fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\ndist/\n.artifacts/\n");
  fs.writeFileSync(path.join(source, "openclaw.mjs"), "export {};\n");
  const targets = new Map<string, Parameters<UpdateRunnerOptions["inspectGitTarget"]>[0]>();
  const commit = (version: string, agentSchema: number) => {
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        packageManager: "pnpm@12.1.0",
        openclaw: { schemaVersions: { state: 5, agent: agentSchema } },
      }),
    );
    git(source, "add", ".");
    git(source, "commit", "-m", "isolated fixture");
    git(source, "tag", `v${version}`);
    const sha = git(source, "rev-parse", "HEAD");
    targets.set(sha, { sha, version, schemaVersions: { state: 5, agent: agentSchema } });
    return sha;
  };
  commit("2026.7.1", 13);
  if (shallow) {
    commit("2026.7.1-beta.1", 13);
    commit("2026.7.1-beta.2", 13);
  }
  if (partialClone) {
    git(source, "config", "uploadpack.allowFilter", "true");
    git(
      root,
      "clone",
      "--filter=blob:none",
      ...(shallow ? ["--depth=2"] : []),
      pathToFileURL(source).href,
      install,
    );
  } else {
    git(root, "clone", source, install);
  }
  git(install, "remote", "rename", "origin", "upstream.with.dots");
  if (relativeRemote) {
    git(install, "remote", "set-url", "upstream.with.dots", path.relative(install, source));
  }
  if (partialClone) {
    // A successful checkout only hydrates current files, not this history blob.
    commit("2026.7.2-beta.1", 14);
  }
  const target = commit("2026.7.2", 14);
  const calls: string[][] = [];
  const runCommand: CommandRunner = async (argv, options) => {
    if (argv[0] === "pnpm") {
      if (argv.includes("build")) {
        const dist = path.join(options.cwd!, "dist");
        fs.mkdirSync(path.join(dist, "control-ui"), { recursive: true });
        fs.writeFileSync(
          path.join(dist, "entry.js"),
          "console.log(JSON.stringify(require('../package.json')));\n",
        );
        fs.writeFileSync(path.join(dist, "control-ui", "index.html"), "ready\n");
      }
      return { code: 0, stdout: argv.includes("--version") ? "12.1.0\n" : "", stderr: "" };
    }
    expect(argv[0]).toBe("git");
    calls.push(argv);
    const result = spawnSync("git", argv.slice(1), {
      cwd: options.cwd,
      env: { ...env, ...options.env },
      encoding: "utf8",
      input: options.input,
      stdio: [options.stdinFileDescriptor ?? "pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const run = (
    options: Partial<Omit<UpdateRunnerOptions, "prepareGitExposure">> = {},
    command: CommandRunner = runCommand,
  ) => {
    const inspected = new Set<string>();
    let mutationAdmitted = false;
    return updateGitCheckout({
      gitRoot: install,
      runCommand: command,
      defaultCommandEnv: env,
      timeoutMs: 15_000,
      startedAt: Date.now(),
      opts: {
        channel: "stable",
        ...options,
        inspectGitTarget: async (candidate) => {
          assert(candidate.sha);
          expect(candidate).toEqual(targets.get(candidate.sha));
          inspected.add(candidate.sha);
          await options.inspectGitTarget?.(candidate);
        },
        validateCandidate: async (candidateRoot) => {
          expect(mutationAdmitted).toBe(false);
          const candidateSha = git(candidateRoot, "rev-parse", "HEAD");
          expect(inspected.has(candidateSha)).toBe(true);
          expect(fs.statSync(path.join(candidateRoot, "dist", "entry.js")).isFile()).toBe(true);
          await options.validateCandidate?.(candidateRoot);
        },
        beforeGitMutation: async (candidate) => {
          assert(candidate.sha);
          expect(inspected.has(candidate.sha)).toBe(true);
          expect(candidate).toEqual(targets.get(candidate.sha));
          await options.beforeGitMutation?.(candidate);
          mutationAdmitted = true;
        },
        runGitDoctor:
          options.runGitDoctor ??
          (async (installedRoot) => {
            expect(mutationAdmitted).toBe(true);
            const installedSha = git(installedRoot, "rev-parse", "HEAD");
            expect(inspected.has(installedSha)).toBe(true);
            const doctor = await runPackageUpdateDoctor({
              root: installedRoot,
              timeoutMs: 15_000,
              progress: {},
              managedServiceEnv: {
                OPENCLAW_STATE_DIR: path.join(root, "state"),
                OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
              },
              nodeRunner: (await resolveCandidateNodeRuntimeForTest()).path,
            });
            expect(doctor?.exitCode, doctor?.stderrTail ?? undefined).toBe(0);
            expect(JSON.parse(doctor?.stdoutTail ?? "")).toMatchObject({
              version: targets.get(installedSha)?.version,
              openclaw: { schemaVersions: targets.get(installedSha)?.schemaVersions },
            });
            return doctor;
          }),
      },
    });
  };
  return { root, source, install, globalConfig, git, commit, target, calls, runCommand, run };
}
