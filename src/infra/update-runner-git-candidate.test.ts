import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { runPackageUpdateDoctor } from "../cli/update-cli/update-command-package.js";
import * as processExec from "../process/exec.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasErrnoCode } from "./errno.js";
import {
  expectRuntime,
  registerGitActivationDoctorOutcomeTests,
  registerGitRuntimeStagingTests,
  runFixtureGit as git,
  resolveCandidateNodeRuntimeForTest,
  runtimeImports,
  writeRuntime,
  type VirtualStoreLayout,
} from "./update-runner-git-candidate.test-support.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

describe("Git candidate activation", () => {
  let directory: string;
  let root: string;
  let remote: string;
  let beforeSha: string;
  let events: string[];
  let stopped: boolean;
  let runCommand: CommandRunner;
  let virtualStoreLayout: VirtualStoreLayout;
  let inspectedTargets: string[];
  let inspectionRoots: string[];

  beforeEach(async () => {
    // Keep fixture-local identity authoritative during candidate rebases.
    vi.stubEnv("GIT_CONFIG_COUNT", "0");
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ]) {
      vi.stubEnv(key, undefined);
    }
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-candidate-")),
    );
    root = path.join(directory, "checkout");
    remote = path.join(directory, "remote");
    await fs.mkdir(remote);
    await git(remote, "init", "--initial-branch=main");
    await git(remote, "config", "user.name", "OpenClaw Test");
    await git(remote, "config", "user.email", "openclaw@example.com");
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        packageManager: "pnpm@12.0.0",
        openclaw: { schemaVersions: { state: 5, agent: 14 } },
      }),
    );
    await fs.writeFile(path.join(remote, "openclaw.mjs"), "export {};\n");
    await fs.mkdir(path.join(remote, "packages", "runtime"), { recursive: true });
    await fs.writeFile(
      path.join(remote, "packages", "runtime", "index.js"),
      "module.exports = require('./node_modules/nested.cjs');",
    );
    await fs.writeFile(
      path.join(remote, ".gitignore"),
      "node_modules/\ndist/\ndist-runtime/\n.artifacts\n.pnpm\ncache/\n",
    );
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "base");
    beforeSha = await git(remote, "rev-parse", "HEAD");
    await git(directory, "clone", "--quiet", remote, root);
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    virtualStoreLayout = "node_modules/.pnpm";
    await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), virtualStoreLayout);
    events = [];
    stopped = false;
    inspectedTargets = [];
    inspectionRoots = [];
    runCommand = async (argv, options) => {
      if (argv[0] === "git") {
        if (argv.includes("init") && argv.includes("--bare")) {
          const mirror = argv.at(-1);
          assert(mirror);
          inspectionRoots.push(path.dirname(mirror));
        }
        return runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "pnpm") {
        if (argv[1] === "build") {
          expect(stopped).toBe(false);
          expect(options.cwd).not.toBe(root);
          await writeRuntime(
            options.cwd!,
            await git(options.cwd!, "rev-parse", "HEAD"),
            path.join(directory, "shared-store"),
            virtualStoreLayout,
          );
          events.push("build");
        }
        return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function advanceRemote() {
    await fs.writeFile(path.join(remote, "candidate.txt"), "candidate\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "candidate");
    return git(remote, "rev-parse", "HEAD");
  }

  function update(opts: Partial<UpdateRunnerOptions> = {}) {
    const { prepareGitExposure, runGitDoctor, ...overrides } = opts;
    const runActivationDoctor = async (doctorRoot: string) => {
      expect(stopped).toBe(true);
      const sha = await git(doctorRoot, "rev-parse", "HEAD");
      expect(inspectedTargets).toContain(sha);
      const doctor = await runPackageUpdateDoctor({
        root: doctorRoot,
        timeoutMs: opts.timeoutMs,
        progress: {},
        managedServiceEnv: {
          OPENCLAW_STATE_DIR: path.join(directory, "state"),
          OPENCLAW_CONFIG_PATH: path.join(directory, "state", "openclaw.json"),
        },
        nodeRunner: (await resolveCandidateNodeRuntimeForTest()).path,
      });
      expect(doctor?.exitCode, doctor?.stderrTail ?? undefined).toBe(0);
      expect(doctor?.stdoutTail?.trim().split("\n")).toEqual(runtimeImports.map(() => sha));
      events.push("migrate");
      return doctor;
    };
    return updateGitCheckout({
      gitRoot: root,
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 5000,
      startedAt: Date.now(),
      opts: {
        channel: "dev",
        inspectGitTarget: async (target) => {
          expect(target).toEqual({
            sha: expect.stringMatching(/^[0-9a-f]{40}$/u),
            version: "2026.9.1",
            schemaVersions: { state: 5, agent: 14 },
          });
          assert(target.sha);
          inspectedTargets.push(target.sha);
        },
        validateCandidate: async (candidateRoot) => {
          expect(stopped).toBe(false);
          expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
          expect(candidateRoot).not.toBe(root);
          const candidateSha = await git(candidateRoot, "rev-parse", "HEAD");
          expect(inspectedTargets).toContain(candidateSha);
          await expectRuntime(candidateRoot, candidateSha);
          events.push("validate");
        },
        beforeGitMutation: async (target) => {
          expect(inspectedTargets).toContain(target.sha);
          expect(stopped).toBe(false);
          stopped = true;
          events.push("stop");
        },
        ...overrides,
        ...(prepareGitExposure
          ? { prepareGitExposure }
          : { runGitDoctor: runGitDoctor ?? runActivationDoctor }),
      },
    });
  }

  async function expectNoRuntimeStagingPaths() {
    for (const inspectionRoot of inspectionRoots) {
      await expect(fs.stat(inspectionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const entries = await fs.readdir(root, { recursive: true });
    expect(
      entries.filter((entry) =>
        /\.openclaw-update-[0-9a-f]{8}-[0-9a-f-]{27}\.tmp(?:\/|$)/u.test(entry),
      ),
    ).toEqual([]);
  }

  it.each([undefined, 5_000])(
    "separates work deadlines from observation budgets: %s",
    async (timeoutMs) => {
      await advanceRemote();
      const commands: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
      const doctorCommands = vi.spyOn(processExec, "runCommandWithTimeout");
      const execute = runCommand;
      runCommand = (argv, options) => {
        commands.push({ argv, timeoutMs: options.timeoutMs });
        return execute(argv, options);
      };
      expect((await update({ timeoutMs })).status).toBe("ok");
      const doctorOptions = doctorCommands.mock.calls.find(([argv]) =>
        argv.includes("doctor"),
      )?.[1];
      expect(doctorOptions).toBeDefined();
      expect(typeof doctorOptions === "number" ? doctorOptions : doctorOptions?.timeoutMs).toBe(
        timeoutMs,
      );
      for (const work of ["install", "build", "fetch", "checkout"]) {
        const command = commands.find(({ argv }) => argv.includes(work));
        expect(command, work).toBeDefined();
        expect(command?.timeoutMs, work).toBe(timeoutMs);
      }
      for (const probe of ["--version", "rev-parse", "status"]) {
        const command = commands.find(({ argv }) => argv.includes(probe));
        expect(command, probe).toBeDefined();
        expect(command?.timeoutMs, probe).toBe(5_000);
      }
      expect(commands.find(({ argv }) => argv.includes("remove"))?.timeoutMs).toBe(5_000);
      expect(inspectionRoots).not.toHaveLength(0);
      await expectNoRuntimeStagingPaths();
    },
  );

  registerGitActivationDoctorOutcomeTests(() => ({
    root,
    beforeSha,
    events,
    isStopped: () => stopped,
    advanceRemote,
    git,
    update,
    expectNoRuntimeStagingPaths,
  }));

  it.each(["dev", "stable", "beta"] as const)(
    "does not stop or build an already-current %s checkout",
    async (channel) => {
      await git(remote, "tag", "v2026.9.1");
      const result = await update({ channel });
      expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
      expect(stopped).toBe(false);
      expect(events).toEqual([]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    },
  );

  it("keeps build and exposure source selection in the admitted candidate", async () => {
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", root);
    await advanceRemote();
    const execute = runCommand;
    let built = false;
    let exposed = false;
    runCommand = async (argv, options) => {
      if (argv[0] === "pnpm" && argv[1] === "build") {
        built = true;
        expect(options.env?.OPENCLAW_DEV_SOURCE_ROOT).toBe(options.cwd);
      }
      return execute(argv, options);
    };
    const result = await update({
      prepareGitExposure: async (candidateRoot, _sha, env) => {
        exposed = true;
        expect(env?.OPENCLAW_DEV_SOURCE_ROOT).toBe(candidateRoot);
      },
    });
    expect(result.status).toBe("ok");
    expect(built && exposed).toBe(true);
    expect(process.env.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
  });

  it("falls back when only the latest dev candidate requires an incompatible Node runtime", async () => {
    const nodeRuntime = await resolveCandidateNodeRuntimeForTest();
    const requiredMajor = Number.parseInt(nodeRuntime.version.split(".")[0]!, 10) + 1;
    const requiredEngine = `>=${requiredMajor}.0.0`;
    const olderCandidate = await advanceRemote();
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        packageManager: "pnpm@12.0.0",
        engines: { node: requiredEngine },
        openclaw: { schemaVersions: { state: 5, agent: 14 } },
      }),
    );
    await git(remote, "add", "package.json");
    await git(remote, "commit", "-m", "require newer node");
    const incompatibleCandidate = await git(remote, "rev-parse", "HEAD");

    const packageManagerCommands: string[][] = [];
    const command = runCommand;
    runCommand = async (argv, options) => {
      if (["pnpm", "npm", "corepack", "bun"].includes(argv[0]!)) {
        packageManagerCommands.push([...argv]);
      }
      return command(argv, options);
    };

    const result = await update();

    expect(result.status, JSON.stringify(result)).toBe("ok");
    const runtimeSteps = result.steps.filter((step) => step.name === "preflight-node-runtime");
    expect(runtimeSteps).toHaveLength(1);
    expect(runtimeSteps[0]).toMatchObject({
      name: "preflight-node-runtime",
      exitCode: 1,
    });
    const runtimeOutput = `${runtimeSteps[0]?.stdoutTail ?? ""}\n${runtimeSteps[0]?.stderrTail ?? ""}`;
    expect(runtimeOutput).toContain(requiredEngine);
    expect(runtimeOutput).toContain(nodeRuntime.path);
    expect(runtimeOutput).toContain(nodeRuntime.version);
    expect(packageManagerCommands).toContainEqual(["pnpm", "build"]);
    expect(result.steps.filter((step) => step.name === "preflight-checkout")).toMatchObject(
      [incompatibleCandidate, olderCandidate].map((sha) => ({
        command: expect.stringContaining(`checkout --detach ${sha}`),
      })),
    );
    expect(events).toEqual(["build", "validate", "stop", "migrate"]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(olderCandidate);
    await expectRuntime(root, olderCandidate);
  });

  it("rejects after all bounded rebased dev candidates require an incompatible Node runtime", async () => {
    const upstreamBase = beforeSha;
    const nodeRuntime = await resolveCandidateNodeRuntimeForTest();
    const requiredMajor = Number.parseInt(nodeRuntime.version.split(".")[0]!, 10) + 1;
    const requiredEngine = `>=${requiredMajor}.0.0`;
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        packageManager: "pnpm@12.0.0",
        engines: { node: requiredEngine },
        openclaw: { schemaVersions: { state: 5, agent: 14 } },
      }),
    );
    await git(root, "add", "package.json");
    await git(root, "commit", "-m", "local change");
    beforeSha = await git(root, "rev-parse", "HEAD");
    await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), virtualStoreLayout);

    const olderCandidate = await advanceRemote();
    await fs.writeFile(path.join(remote, "latest.txt"), "latest\n");
    await git(remote, "add", "latest.txt");
    await git(remote, "commit", "-m", "latest candidate");
    const latestCandidate = await git(remote, "rev-parse", "HEAD");

    const packageManagerCommands: string[][] = [];
    const command = runCommand;
    runCommand = async (argv, options) => {
      if (["pnpm", "npm", "corepack", "bun"].includes(argv[0]!)) {
        packageManagerCommands.push([...argv]);
      }
      return command(argv, options);
    };

    const result = await update();

    expect(result).toMatchObject({
      status: "error",
      reason: "preflight-node-runtime-incompatible",
    });
    const runtimeSteps = result.steps.filter((step) => step.name === "preflight-node-runtime");
    expect(result.steps.filter((step) => step.name === "preflight-checkout")).toMatchObject(
      [latestCandidate, olderCandidate, upstreamBase].map((sha) => ({
        command: expect.stringContaining(`checkout --detach ${sha}`),
      })),
    );
    expect(runtimeSteps).toHaveLength(3);
    for (const step of runtimeSteps) {
      expect(step.exitCode).toBe(1);
      const output = `${step.stdoutTail ?? ""}\n${step.stderrTail ?? ""}`;
      expect(output).toContain(requiredEngine);
      expect(output).toContain(nodeRuntime.path);
      expect(output).toContain(nodeRuntime.version);
    }
    expect(packageManagerCommands).toEqual([]);
    expect(stopped).toBe(false);
    expect(events).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    await expectRuntime(root, beforeSha);
  });

  it("stages an already-current checkout when converting a package install to Git", async () => {
    const result = await update({
      prepareGitExposure: async (candidateRoot, sha) => {
        expect(stopped).toBe(false);
        expect(await git(candidateRoot, "rev-parse", "HEAD")).toBe(sha);
        events.push("prepare exposure");
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(events).toEqual(["build", "prepare exposure", "validate", "stop"]);
    await expectRuntime(root, beforeSha);
    await expectNoRuntimeStagingPaths();
  });

  it("does not exempt stale staging paths during initial admission", async () => {
    const stale = path.join(root, "dist.openclaw-update-00000000-0000-0000-0000-000000000000.tmp");
    await fs.mkdir(stale);
    await fs.writeFile(path.join(stale, "candidate"), "operator-owned");
    const result = await update();
    expect(result).toMatchObject({ status: "error", reason: "dirty" });
    expect(events).toEqual([]);
    expect(await fs.readFile(path.join(stale, "candidate"), "utf8")).toBe("operator-owned");
  });

  it.each(["untracked", "tracked", "head", "branch"] as const)(
    "preserves %s source changes made during validation without stopping the service",
    async (mutation) => {
      await advanceRemote();
      const result = await update({
        validateCandidate: async () => {
          if (mutation === "untracked") {
            await fs.mkdir(path.join(root, "dist.openclaw-update-operator.tmp"));
            await fs.writeFile(
              path.join(root, "dist.openclaw-update-operator.tmp", "keep.txt"),
              "keep this change",
            );
          } else if (mutation === "tracked") {
            await fs.appendFile(path.join(root, "package.json"), "\n");
          } else if (mutation === "head") {
            await fs.writeFile(path.join(root, "operator-change.txt"), "committed change");
            await git(root, "add", "operator-change.txt");
            await git(root, "commit", "-m", "operator change");
          } else {
            await git(root, "checkout", "-b", "operator-branch");
          }
        },
      });
      expect(result).toMatchObject({ status: "error", reason: "dirty" });
      expect(stopped).toBe(false);
      if (mutation === "untracked") {
        expect(
          await fs.readFile(
            path.join(root, "dist.openclaw-update-operator.tmp", "keep.txt"),
            "utf8",
          ),
        ).toBe("keep this change");
      } else if (mutation === "tracked") {
        expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toMatch(/\n$/u);
      } else if (mutation === "head") {
        expect(await git(root, "rev-parse", "HEAD")).not.toBe(beforeSha);
      } else {
        expect(await git(root, "branch", "--show-current")).toBe("operator-branch");
      }
      if (mutation !== "head") {
        expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      }
      await expectNoRuntimeStagingPaths();
    },
  );

  it.each([
    { source: "workspace", version: "10.23.0", dirtyWorkspace: false },
    { source: "workspace symlink", version: "10.23.0", dirtyWorkspace: false },
    { source: "ambient", version: "11.24.0", dirtyWorkspace: false },
    { source: "workspace", version: "10.23.0", dirtyWorkspace: true },
  ])(
    "isolates candidate installs from the $source virtual store (build changes workspace: $dirtyWorkspace)",
    async ({ source, version, dirtyWorkspace }) => {
      const operatorStore = path.join(root, "node_modules", "operator-store");
      const workspace = `# preserve operator formatting\npackages:\n  - packages/*\n${
        source !== "ambient" ? `virtualStoreDir: ${JSON.stringify(operatorStore)}\n` : ""
      }`;
      const workspaceFile = path.join(remote, "pnpm-workspace.yaml");
      const workspaceTarget =
        source === "workspace symlink"
          ? path.join(directory, "operator-workspace.yaml")
          : workspaceFile;
      await fs.writeFile(workspaceTarget, workspace);
      if (workspaceTarget !== workspaceFile) {
        await fs.symlink(workspaceTarget, workspaceFile);
      }
      await fs.writeFile(
        path.join(remote, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.9.1",
          packageManager: `pnpm@${version}`,
          openclaw: { schemaVersions: { state: 5, agent: 14 } },
        }),
      );
      await git(remote, "add", ".");
      await git(remote, "commit", "-m", "operator store");
      await git(root, "fetch", "origin");
      await git(root, "merge", "--ff-only", "origin/main");
      beforeSha = await git(root, "rev-parse", "HEAD");
      await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), operatorStore);
      const target = await advanceRemote();
      for (const key of [
        "npm_config_virtual_store_dir",
        "NPM_CONFIG_VIRTUAL_STORE_DIR",
        "PNPM_CONFIG_VIRTUAL_STORE_DIR",
        "pnpm_config_virtual_store_dir",
      ]) {
        vi.stubEnv(key, operatorStore);
      }
      vi.stubEnv("OPENCLAW_UPDATE_PREFLIGHT_LINT", "1");
      const candidateCommands = ["install", "build", "ui:build", "lint"];
      const command = runCommand;
      runCommand = async (argv, options) => {
        if (argv[0] !== "pnpm") {
          return command(argv, options);
        }
        if (argv[1] === "--version") {
          return { code: 0, stdout: version, stderr: "" };
        }
        if (!candidateCommands.includes(argv[1]!)) {
          return command(argv, options);
        }
        const cwd = options.cwd!;
        expect(await fs.readFile(workspaceTarget, "utf8")).toBe(workspace);
        const config = YAML.parse(await fs.readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8"));
        const env = { ...process.env, ...options.env };
        // pnpm10 gives workspace YAML priority; pnpm11 normalizes environment keys
        // in insertion order. A nested install never inherits the outer CLI flags.
        const ambient =
          Object.entries(env).findLast(
            ([key]) => key.toLowerCase() === "pnpm_config_virtual_store_dir",
          )?.[1] ??
          env.npm_config_virtual_store_dir ??
          env.NPM_CONFIG_VIRTUAL_STORE_DIR;
        const selected =
          source !== "ambient"
            ? (config.virtualStoreDir ?? ambient)
            : (ambient ?? config.virtualStoreDir);
        const store = path.resolve(cwd, selected ?? "node_modules/.pnpm");
        // Model pruning the previous package generation, as the real pnpm proof does.
        await fs.rm(path.join(store, beforeSha), { recursive: true, force: true });
        await writeRuntime(
          cwd,
          await git(cwd, "rev-parse", "HEAD"),
          path.join(directory, "shared-store"),
          store,
        );
        if (argv[1] === "build") {
          await fs.rm(path.join(cwd, "dist", "control-ui", "index.html"));
          if (dirtyWorkspace) {
            await fs.appendFile(
              path.join(cwd, "pnpm-workspace.yaml"),
              "# build changed this file\n",
            );
          }
        }
        expect(stopped).toBe(false);
        await expectRuntime(root, beforeSha);
        events.push(argv[1]!);
        return { code: 0, stdout: "", stderr: "" };
      };
      const result = await update({
        devTarget: { mode: "detached", ref: target },
        prepareGitExposure: async (cwd, sha, env) => {
          expect(sha).toBe(target);
          expect(env).toBeDefined();
          await runCommand(["pnpm", "install"], { cwd, env });
          events.push("exposure");
        },
        beforeGitMutation: async (candidate) => {
          expect(candidate.sha).toBe(target);
          expect(inspectedTargets).toContain(target);
          await expectRuntime(root, beforeSha);
          expect(await fs.readFile(path.join(root, "pnpm-workspace.yaml"), "utf8")).toBe(workspace);
          stopped = true;
          events.push("stop");
        },
      });
      expect(await fs.readFile(path.join(root, "pnpm-workspace.yaml"), "utf8")).toBe(workspace);
      expect(await fs.readFile(workspaceTarget, "utf8")).toBe(workspace);
      if (source === "workspace symlink") {
        expect(await fs.readlink(path.join(root, "pnpm-workspace.yaml"))).toBe(workspaceTarget);
      }
      const candidateEvents = [...candidateCommands, "install", "exposure", "validate"];
      if (dirtyWorkspace) {
        expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "preflight-update-clean-check",
            exitCode: 1,
            stdoutTail: expect.stringContaining("pnpm-workspace.yaml"),
          }),
        );
        expect(events).toEqual(candidateEvents);
        expect(stopped).toBe(false);
        expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
        await expectRuntime(root, beforeSha);
        return;
      }
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(events).toEqual([...candidateEvents, "stop"]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(target);
      await expectRuntime(root, target);
      const manifest = YAML.parse(
        await fs.readFile(path.join(root, "node_modules", ".modules.yaml"), "utf8"),
      );
      expect(path.resolve(root, "node_modules", manifest.virtualStoreDir)).toBe(
        path.join(root, "node_modules", ".pnpm"),
      );
    },
  );

  it.each([
    { layout: "node_modules/.pnpm", localCommit: false },
    { layout: "node_modules/.cache/jiti", localCommit: false },
    { layout: "node_modules/.vite/deps", localCommit: false },
    { layout: "node_modules/.pnpm", localCommit: true },
    { layout: ".pnpm", localCommit: false },
    { layout: "cache/deps", localCommit: false },
    { layout: "../store", localCommit: false },
    { layout: "external", localCommit: false },
    { layout: "symlink", localCommit: false },
  ] as const)(
    "activates the validated $layout runtime (preserving local commits: $localCommit)",
    async ({ layout, localCommit }) => {
      virtualStoreLayout = layout;
      await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), layout);
      const target = await advanceRemote();
      if (localCommit) {
        const artifacts = path.join(directory, "external-artifacts");
        await fs.mkdir(artifacts);
        await fs.symlink(artifacts, path.join(root, ".artifacts"), "junction");
        await fs.writeFile(path.join(root, "local.txt"), "operator change\n");
        await git(root, "add", "local.txt");
        await git(root, "commit", "-m", "local change");
        beforeSha = await git(root, "rev-parse", "HEAD");
        await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), layout);
      }
      const unrelated = path.join(root, "operator-project", "node_modules", "keep.cjs");
      await fs.mkdir(path.dirname(unrelated), { recursive: true });
      await fs.writeFile(unrelated, "operator-owned");
      const result = await update();
      expect(await fs.readFile(unrelated, "utf8")).toBe("operator-owned");
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(events).toEqual(["build", "validate", "stop", "migrate"]);
      const current = await git(root, "rev-parse", "HEAD");
      expect(result.before?.buildId).toBe(beforeSha);
      expect(result.after).toMatchObject({ sha: current, buildId: current });
      expect(await git(root, "merge-base", current, target)).toBe(target);
      expect.soft(await git(root, "rev-parse", "@{upstream}")).toBe(target);
      if (localCommit) {
        expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator change\n");
        const committer = await git(root, "log", "-1", "--format=%cn <%ce>");
        expect.soft(committer).toBe("OpenClaw Test <openclaw@example.com>");
      }
      await expectRuntime(root, current);
      const manifest: { virtualStoreDir: string } = JSON.parse(
        await fs.readFile(path.join(root, "node_modules", ".modules.yaml"), "utf8"),
      );
      const expectedStore =
        layout === "external"
          ? path.join(directory, "shared-store", "virtual-store")
          : layout === "symlink"
            ? path.join(directory, "shared-store", "linked-store", current)
            : path.resolve(root, layout);
      expect(await fs.realpath(path.resolve(root, "node_modules", manifest.virtualStoreDir))).toBe(
        expectedStore,
      );
      expect(await fs.realpath(path.join(root, "node_modules", "virtual-runtime"))).toBe(
        path.join(expectedStore, current, "node_modules", "virtual-runtime"),
      );
      const retainedArtifacts = await fs
        .readdir(path.join(root, ".artifacts"))
        .catch((error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return [];
        });
      expect(retainedArtifacts).toEqual([]);
    },
  );

  it("preserves a local upstream without inventing a remote ref", async () => {
    const target = await advanceRemote();
    await git(root, "fetch", "origin");
    await git(root, "branch", "operator-target", target);
    await git(root, "config", "branch.main.remote", ".");
    await git(root, "config", "branch.main.merge", "refs/heads/operator-target");
    const result = await update();
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(await git(root, "rev-parse", "HEAD")).toBe(target);
    expect(await git(root, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
      "refs/heads/operator-target",
    );
    await expectRuntime(root, target);
  });

  it("preserves required signatures when a candidate rebase fails", async () => {
    await advanceRemote();
    await fs.writeFile(path.join(root, "local.txt"), "operator change\n");
    await git(root, "add", "local.txt");
    await git(root, "commit", "-m", "local change");
    beforeSha = await git(root, "rev-parse", "HEAD");
    await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), virtualStoreLayout);
    // A deliberately non-signing executable rejects Git's signing request without a key.
    await git(root, "config", "gpg.program", process.execPath);
    await git(root, "config", "commit.gpgSign", "true");
    const abortTimeouts: Array<number | undefined> = [];
    const execute = runCommand;
    runCommand = (argv, options) => {
      if (argv.includes("rebase") && argv.includes("--abort")) {
        abortTimeouts.push(options.timeoutMs);
      }
      return execute(argv, options);
    };
    const result = await update();
    // The existing fallback can retain the old candidate without creating a commit.
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(
      result.steps.some((step) => step.name === "preflight-rebase" && step.exitCode !== 0),
    ).toBe(true);
    expect(abortTimeouts.length).toBeGreaterThan(0);
    for (const timeoutMs of abortTimeouts) {
      expect(timeoutMs).toBe(5_000);
    }
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    await expectRuntime(root, beforeSha);
  });

  registerGitRuntimeStagingTests(() => ({
    root,
    beforeSha,
    isStopped: () => stopped,
    advanceRemote,
    git,
    update,
    expectNoRuntimeStagingPaths,
  }));

  it.each(["working", "staged", "committed"] as const)(
    "refuses activation when validation repairs %s source outside the selected commit",
    async (repairState) => {
      await fs.writeFile(
        path.join(remote, "openclaw.mjs"),
        "throw new Error('broken launcher');\n",
      );
      const target = await advanceRemote();
      let validated = false;
      const result = await update({
        devTarget: { mode: "detached", ref: target },
        validateCandidate: async (candidateRoot) => {
          const launcher = path.join(candidateRoot, "openclaw.mjs");
          await fs.writeFile(launcher, "export {};\n");
          if (repairState !== "working") {
            await git(candidateRoot, "add", "openclaw.mjs");
          }
          if (repairState === "committed") {
            await git(candidateRoot, "commit", "-m", "repair launcher");
          }
          const probe = await runCommandWithTimeout([process.execPath, launcher], {
            timeoutMs: 5000,
          });
          expect(probe.code).toBe(0);
          validated = true;
        },
      });
      expect(validated).toBe(true);
      expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
      expect(stopped).toBe(false);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await fs.readFile(path.join(root, "openclaw.mjs"), "utf8")).toBe("export {};\n");
      await expectNoRuntimeStagingPaths();
    },
  );

  it.each([
    {
      layout: "node_modules/.pnpm",
      restoreSource: true,
      restoreRuntime: true,
      timeoutMs: undefined,
    },
    { layout: "node_modules/.pnpm", restoreSource: false, restoreRuntime: true, timeoutMs: 5_000 },
    {
      layout: "node_modules/.pnpm",
      restoreSource: "throw",
      restoreRuntime: true,
      timeoutMs: undefined,
    },
    { layout: "../store", restoreSource: true, restoreRuntime: true, timeoutMs: undefined },
    {
      layout: "node_modules/.pnpm",
      restoreSource: true,
      restoreRuntime: false,
      timeoutMs: undefined,
    },
  ] as const)(
    "verifies $layout runtime recovery after activation failure (source restored: $restoreSource, runtime restored: $restoreRuntime)",
    async ({ layout, restoreSource, restoreRuntime, timeoutMs }) => {
      virtualStoreLayout = layout;
      await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), layout);
      const originalCache = path.join(root, "node_modules", ".cache", "jiti", "original.cjs");
      await fs.mkdir(path.dirname(originalCache), { recursive: true });
      await fs.writeFile(originalCache, "original runtime cache");
      const candidateSha = await advanceRemote();
      const command = runCommand;
      let resetFaultInjected = false;
      const recoveryTimeouts: Array<number | undefined> = [];
      runCommand = async (argv, options) => {
        if (faultInjected && argv[0] === "git" && argv[2] === root) {
          recoveryTimeouts.push(options.timeoutMs);
        }
        if (
          restoreSource !== true &&
          argv[0] === "git" &&
          argv[2] === root &&
          argv[3] === "reset" &&
          argv[4] === "--hard" &&
          argv[5] === beforeSha
        ) {
          resetFaultInjected = true;
          if (restoreSource === "throw") {
            throw new Error("rollback command unavailable");
          }
          return { code: 1, stdout: "", stderr: "source restoration failed" };
        }
        return command(argv, options);
      };
      const rename = fs.rename.bind(fs);
      const injected = new Error("activation blocked");
      let faultInjected = false;
      let distBackup: string | undefined;
      let restoreFaultInjected = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (source === path.join(root, "dist")) {
          distBackup = String(destination);
        }
        if (!restoreRuntime && source === distBackup && destination === path.join(root, "dist")) {
          restoreFaultInjected = true;
          await fs.mkdir(destination, { recursive: true });
          await fs.writeFile(path.join(destination, "restore-race"), "occupied");
        }
        if (
          String(source).endsWith(`${path.sep}candidate`) &&
          destination === path.join(root, "node_modules")
        ) {
          faultInjected = true;
          throw injected;
        }
        return rename(source, destination);
      });
      const onRollbackOutcome = vi.fn(() => {
        if (!restoreRuntime) {
          throw new Error("diagnostic storage unavailable");
        }
      });
      const execution = update({ timeoutMs, progress: { onRollbackOutcome } });
      if (restoreSource === "throw") {
        await expect(execution).rejects.toThrow("rollback command unavailable");
        expect(resetFaultInjected).toBe(true);
        expect(onRollbackOutcome).toHaveBeenLastCalledWith({
          status: "failed",
          reason: "Rollback threw before restoration could be verified",
        });
        return;
      }
      const result = await execution;
      expect(recoveryTimeouts.length).toBeGreaterThan(0);
      expect(recoveryTimeouts.every((deadline) => deadline === 5_000)).toBe(true);
      expect(onRollbackOutcome).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: restoreSource && restoreRuntime ? "succeeded" : "failed",
        }),
      );
      expect(faultInjected).toBe(true);
      expect(resetFaultInjected).toBe(!restoreSource);
      expect(restoreFaultInjected).toBe(!restoreRuntime);
      expect(result).toMatchObject({
        status: "error",
        recovery: !restoreSource
          ? { serviceRestartSafe: false, reason: "source-rollback-failed" }
          : restoreRuntime
            ? { serviceRestartSafe: true, buildId: beforeSha }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      expect(events).toEqual(["build", "validate", "stop"]);
      const expectedSha = restoreSource ? beforeSha : candidateSha;
      expect(await git(root, "rev-parse", "HEAD")).toBe(expectedSha);
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "git-rollback-verify-head",
          exitCode: restoreSource ? 0 : 1,
          stdoutTail: expectedSha,
          ...(restoreSource ? {} : { stderrTail: `expected ${beforeSha}, found ${candidateSha}` }),
        }),
      );
      if (!restoreRuntime) {
        if (!distBackup) {
          throw new Error("The original dist backup was not observed.");
        }
        expect(
          JSON.parse(await fs.readFile(path.join(distBackup, "build-info.json"), "utf8")),
        ).toMatchObject({
          commit: beforeSha,
        });
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "git-runtime-rollback",
            exitCode: 1,
            stderrTail: expect.stringContaining(distBackup),
          }),
        );
        return;
      }
      await expectRuntime(root, beforeSha);
      expect(await fs.readFile(originalCache, "utf8")).toBe("original runtime cache");
    },
  );

  it.each([false, true])(
    "retries partial runtime restoration without losing originals (cleanup first: %s)",
    async (cleanupFirst) => {
      const candidateSha = await advanceRemote();
      await git(root, "fetch", "origin");
      const cleanupRoot = path.join(directory, "restore-candidate");
      const candidateRoot = path.join(cleanupRoot, "worktree");
      await fs.mkdir(cleanupRoot);
      await git(root, "worktree", "add", "--detach", candidateRoot, candidateSha);
      await writeRuntime(
        candidateRoot,
        candidateSha,
        path.join(directory, "shared-store"),
        virtualStoreLayout,
      );
      await expectRuntime(candidateRoot, candidateSha);
      const promotion = await prepareGitRuntimePromotion(
        root,
        candidateRoot,
        runCommand,
        5000,
        cleanupRoot,
      );
      await git(root, "worktree", "remove", "--force", candidateRoot);
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      const rename = fs.rename.bind(fs);
      let distBackup: string | undefined;
      let rejectRestore = true;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (source === path.join(root, "dist")) {
          distBackup = String(destination);
        }
        if (rejectRestore && source === distBackup && destination === path.join(root, "dist")) {
          await fs.mkdir(destination, { recursive: true });
          await fs.writeFile(path.join(destination, "restore-race"), "occupied");
        }
        return rename(source, destination);
      });
      await promotion.activate();
      await expectRuntime(root, candidateSha);
      await expect(promotion.restore()).rejects.toThrow();
      if (cleanupFirst) {
        await promotion.cleanup();
      }
      if (!distBackup) {
        throw new Error("The original dist backup was not observed.");
      }
      expect(
        JSON.parse(await fs.readFile(path.join(distBackup, "build-info.json"), "utf8")),
      ).toMatchObject({
        commit: beforeSha,
      });
      expect(await fs.readFile(path.join(root, "node_modules", "identity.cjs"), "utf8")).toContain(
        beforeSha,
      );
      rejectRestore = false;
      await promotion.restore();
      await expectRuntime(root, beforeSha);
      await promotion.cleanup();
      await expect(fs.stat(path.dirname(distBackup))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
