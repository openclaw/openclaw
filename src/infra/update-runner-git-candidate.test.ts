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
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import {
  advanceFixtureRemote,
  createGitFixtureCheckout,
  expectNoGitRuntimeStagingPaths,
  expectRuntime,
  prepareDeletedTrackedRuntimeAsset,
  registerGitRuntimeStagingTests,
  registerGitRuntimeRestorationTests,
  runFixtureGit as git,
  resolveCandidateNodeRuntimeForTest,
  runtimeImports,
  writeGitFixtureManifest,
  writeRuntime,
  type VirtualStoreLayout,
  expectHead,
  expectMissing,
  readText,
  expectFile,
  expectStep,
  type GitCandidateFixture,
} from "./update-runner-git-candidate.test-support.js";
import { registerGitActivationDoctorOutcomeTests } from "./update-runner-git-transactions.test-support.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

describe("Git candidate activation", () => {
  const packageMetadata = { openclaw: { schemaVersions: { state: 5, agent: 14 } } };
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

  const writeCheckoutRuntime = (
    checkout = root,
    sha = beforeSha,
    layout: string = virtualStoreLayout,
  ) => writeRuntime(checkout, sha, path.join(directory, "shared-store"), layout);

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-candidate-")),
    );
    ({ root, remote, beforeSha } = await createGitFixtureCheckout(directory, packageMetadata));
    virtualStoreLayout = "node_modules/.pnpm";
    await writeCheckoutRuntime();
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
          await writeCheckoutRuntime(options.cwd!, await git(options.cwd!, "rev-parse", "HEAD"));
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

  const advanceRemote = () => advanceFixtureRemote(remote);

  function observeCommands(observe: (...args: Parameters<CommandRunner>) => void | Promise<void>) {
    const execute = runCommand;
    runCommand = async (...args) => {
      await observe(...args);
      return execute(...args);
    };
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
          await expectHead(root, beforeSha);
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

  const expectNoRuntimeStagingPaths = () => expectNoGitRuntimeStagingPaths(root, inspectionRoots);

  it("separates work deadlines from observation budgets", async () => {
    const timeoutMs = undefined;
    await advanceRemote();
    const commands: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    const doctorCommands = vi.spyOn(processExec, "runCommandWithTimeout");
    observeCommands((argv, options) => {
      commands.push({ argv, timeoutMs: options.timeoutMs });
    });
    expect((await update({ timeoutMs })).status).toBe("ok");
    const doctorOptions = doctorCommands.mock.calls.find(([argv]) => argv.includes("doctor"))?.[1];
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
  });

  it("reports candidate checks and runtime activation among the Git update steps", async () => {
    await advanceRemote();
    const cleanup = {
      name: "candidate-state-cleanup",
      command: "rm -rf -- /synthetic/openclaw-update-canary",
      cwd: root,
      durationMs: 900,
      exitCode: 0,
    };
    const result = await update({ validateCandidate: async () => [cleanup] });
    expect(result.status).toBe("ok");
    const names = result.steps.map((step) => step.name);
    expect(result.steps).toContainEqual(cleanup);
    expect(names.indexOf("candidate-state-cleanup")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("candidate-state-cleanup")).toBeLessThan(
      names.indexOf("preflight-update-clean-check"),
    );
    expect(result.steps.find((step) => step.name === "git-runtime-activation")).toMatchObject({
      exitCode: 0,
      durationMs: expect.any(Number),
    });
    expect(names.indexOf("git-runtime-activation")).toBeGreaterThan(names.indexOf("git-checkout"));
  });

  const fixture = (): GitCandidateFixture => ({
    directory,
    root,
    beforeSha,
    events,
    virtualStoreLayout,
    runCommand,
    advanceRemote,
    update,
    expectNoRuntimeStagingPaths,
    isStopped: () => stopped,
    setRunCommand: (runner) => {
      runCommand = runner;
    },
  });
  registerGitActivationDoctorOutcomeTests(fixture);

  it("preserves an incomplete installed runtime when the candidate build fails", async () => {
    await fs.rm(path.join(root, "dist", ".runtime-postbuildstamp"));
    await advanceRemote();
    const execute = runCommand;
    runCommand = (argv, options) =>
      argv[0] === "pnpm" && argv[1] === "build"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "synthetic build failure" })
        : execute(argv, options);

    const result = await update();

    expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
    expect({ stopped, events }).toEqual({ stopped: false, events: [] });
    await expectMissing(path.join(root, "dist", ".runtime-postbuildstamp"));
    await expectHead(root, beforeSha);
    await expectNoRuntimeStagingPaths();
  });

  it("rebuilds a source-current checkout before activating its stale runtime", async () => {
    const builtSha = beforeSha;
    const target = await advanceRemote();
    await git(remote, "tag", "v2026.9.1");
    await git(root, "pull", "--ff-only");
    beforeSha = target;
    const buildInfoPath = path.join(root, "dist", "build-info.json");
    await fs.writeFile(buildInfoPath, JSON.stringify({ buildId: builtSha }));
    await expectRuntime(root, builtSha);

    const result = await update({
      beforeGitMutation: async () => {
        expect(stopped).toBe(false);
        await expectRuntime(root, builtSha);
        stopped = true;
        events.push("stop");
      },
    });

    expect(result).toMatchObject({
      status: "ok",
      before: { sha: target, buildId: builtSha },
      after: { sha: target, buildId: target },
    });
    expect(events).toEqual(["build", "validate", "stop", "migrate"]);
    await expectRuntime(root, target);
    expect(JSON.parse(await readText(buildInfoPath))).toMatchObject({ commit: target });

    stopped = false;
    events.length = 0;
    expect(await update()).toMatchObject({
      status: "skipped",
      reason: "already-current",
      before: { sha: target, buildId: target },
    });
    expect({ stopped, events }).toEqual({ stopped: false, events: [] });
    await expectNoRuntimeStagingPaths();
  });

  it("keeps build and exposure source selection in the admitted candidate", async () => {
    vi.stubEnv("OPENCLAW_DEV_SOURCE_ROOT", root);
    const otherTools = path.join(directory, "other-tools");
    const inheritedPath = `${otherTools}${path.delimiter}${process.env.PATH ?? ""}`;
    vi.stubEnv("PATH", inheritedPath);
    const nodeRuntime = await resolveCandidateNodeRuntimeForTest();
    await advanceRemote();
    let built = false;
    let exposed = false;
    observeCommands(async (argv, options) => {
      if (argv[0] === "pnpm" && argv[1] === "build") {
        built = true;
        expect(options.env?.OPENCLAW_DEV_SOURCE_ROOT).toBe(options.cwd);
        expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(otherTools);
        const selectedNode = await runCommandWithTimeout(["node", "-p", "process.execPath"], {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: 5000,
        });
        expect(selectedNode.code, selectedNode.stderr).toBe(0);
        expect(selectedNode.stdout.trim()).toBe(await fs.realpath(nodeRuntime.path));
      }
    });
    const result = await update({
      prepareGitExposure: async (candidateRoot, _sha, env) => {
        exposed = true;
        expect(env?.OPENCLAW_DEV_SOURCE_ROOT).toBe(candidateRoot);
        const exposedNode = resolveExecutableFromPathEnv("node", env?.PATH ?? "", env, {
          cwd: candidateRoot,
          useCache: false,
        });
        expect(exposedNode).toBeDefined();
        expect(await fs.realpath(exposedNode!)).toBe(await fs.realpath(nodeRuntime.path));
      },
    });
    expect(result.status).toBe("ok");
    expect(built && exposed).toBe(true);
    expect(process.env.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
    expect(process.env.PATH).toBe(inheritedPath);
  });

  it("rejects after all bounded rebased dev candidates require an incompatible Node runtime", async () => {
    const upstreamBase = beforeSha;
    const nodeRuntime = await resolveCandidateNodeRuntimeForTest();
    const requiredMajor = Number.parseInt(nodeRuntime.version.split(".")[0]!, 10) + 1;
    const requiredEngine = `>=${requiredMajor}.0.0`;
    await writeGitFixtureManifest(root, { engines: { node: requiredEngine }, ...packageMetadata });
    await git(root, "add", "package.json");
    await git(root, "commit", "-m", "local change");
    beforeSha = await git(root, "rev-parse", "HEAD");
    await writeCheckoutRuntime();

    const olderCandidate = await advanceRemote();
    await fs.writeFile(path.join(remote, "latest.txt"), "latest\n");
    await git(remote, "add", "latest.txt");
    await git(remote, "commit", "-m", "latest candidate");
    const latestCandidate = await git(remote, "rev-parse", "HEAD");

    const packageManagerCommands: string[][] = [];
    observeCommands((argv) => {
      if (["pnpm", "npm", "corepack", "bun"].includes(argv[0]!)) {
        packageManagerCommands.push([...argv]);
      }
    });

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
      const reportedNode = step.stdoutTail?.match(
        /^Node \S+ \((.+)\); requires engines\.node /,
      )?.[1];
      expect(reportedNode).toBeDefined();
      expect(await fs.realpath(reportedNode!)).toBe(await fs.realpath(nodeRuntime.path));
      expect(output).toContain(nodeRuntime.version);
    }
    expect(packageManagerCommands).toEqual([]);
    expect({ stopped, events }).toEqual({ stopped: false, events: [] });
    await expectHead(root, beforeSha);
    await expectRuntime(root, beforeSha);
  });

  it("does not exempt stale staging paths during initial admission", async () => {
    const stale = path.join(root, "dist.openclaw-update-00000000-0000-0000-0000-000000000000.tmp");
    await fs.mkdir(stale);
    await fs.writeFile(path.join(stale, "candidate"), "operator-owned");
    const result = await update();
    expect(result).toMatchObject({ status: "error", reason: "dirty" });
    expect(events).toEqual([]);
    await expectFile(path.join(stale, "candidate"), "operator-owned");
  });

  it.each(["untracked", "head", "branch"] as const)(
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
        await expectFile(
          path.join(root, "dist.openclaw-update-operator.tmp", "keep.txt"),
          "keep this change",
        );
      } else if (mutation === "head") {
        expect(await git(root, "rev-parse", "HEAD")).not.toBe(beforeSha);
      } else {
        expect(await git(root, "branch", "--show-current")).toBe("operator-branch");
      }
      if (mutation !== "head") {
        await expectHead(root, beforeSha);
      }
      await expectNoRuntimeStagingPaths();
    },
  );

  it.each([
    { source: "workspace", dirtyWorkspace: false },
    { source: "workspace symlink", dirtyWorkspace: false },
    { source: "workspace", dirtyWorkspace: true },
  ])(
    "isolates candidate installs from the $source virtual store (build changes workspace: $dirtyWorkspace)",
    async ({ source, dirtyWorkspace }) => {
      const version = "10.23.0";
      const operatorStore = path.join(root, "node_modules", "operator-store");
      const workspace = `# preserve operator formatting\npackages:\n  - packages/*\nvirtualStoreDir: ${JSON.stringify(operatorStore)}\n`;
      const workspaceFile = path.join(remote, "pnpm-workspace.yaml");
      const workspaceTarget =
        source === "workspace symlink"
          ? path.join(directory, "operator-workspace.yaml")
          : workspaceFile;
      await fs.writeFile(workspaceTarget, workspace);
      if (workspaceTarget !== workspaceFile) {
        await fs.symlink(workspaceTarget, workspaceFile);
      }
      await writeGitFixtureManifest(remote, {
        packageManager: `pnpm@${version}`,
        ...packageMetadata,
      });
      await git(remote, "add", ".");
      await git(remote, "commit", "-m", "operator store");
      await git(root, "fetch", "origin");
      await git(root, "merge", "--ff-only", "origin/main");
      beforeSha = await git(root, "rev-parse", "HEAD");
      await writeCheckoutRuntime(root, beforeSha, operatorStore);
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
        await expectFile(workspaceTarget, workspace);
        const config = YAML.parse(await readText(path.join(cwd, "pnpm-workspace.yaml")));
        const env = { ...process.env, ...options.env };
        // pnpm10 gives workspace YAML priority; nested installs do not inherit CLI flags.
        const ambient =
          Object.entries(env).findLast(
            ([key]) => key.toLowerCase() === "pnpm_config_virtual_store_dir",
          )?.[1] ??
          env.npm_config_virtual_store_dir ??
          env.NPM_CONFIG_VIRTUAL_STORE_DIR;
        const selected = config.virtualStoreDir ?? ambient;
        const store = path.resolve(cwd, selected ?? "node_modules/.pnpm");
        // Model pruning the previous package generation, as the real pnpm proof does.
        await fs.rm(path.join(store, beforeSha), { recursive: true, force: true });
        await writeCheckoutRuntime(cwd, await git(cwd, "rev-parse", "HEAD"), store);
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
          await expectFile(path.join(root, "pnpm-workspace.yaml"), workspace);
          stopped = true;
          events.push("stop");
        },
      });
      await expectFile(path.join(root, "pnpm-workspace.yaml"), workspace);
      await expectFile(workspaceTarget, workspace);
      if (source === "workspace symlink") {
        expect(await fs.readlink(path.join(root, "pnpm-workspace.yaml"))).toBe(workspaceTarget);
      }
      const candidateEvents = [...candidateCommands, "install", "exposure", "validate"];
      if (dirtyWorkspace) {
        expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
        expectStep(result.steps, {
          name: "preflight-update-clean-check",
          exitCode: 1,
          stdoutTail: expect.stringContaining("pnpm-workspace.yaml"),
        });
        expect(events).toEqual(candidateEvents);
        expect(stopped).toBe(false);
        await expectHead(root, beforeSha);
        await expectRuntime(root, beforeSha);
        return;
      }
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(events).toEqual([...candidateEvents, "stop"]);
      await expectHead(root, target);
      await expectRuntime(root, target);
      const manifest = YAML.parse(await readText(path.join(root, "node_modules", ".modules.yaml")));
      expect(path.resolve(root, "node_modules", manifest.virtualStoreDir)).toBe(
        path.join(root, "node_modules", ".pnpm"),
      );
    },
  );

  it.each(["cache/deps", "../store", "external", "symlink"] as const)(
    "activates the validated %s runtime",
    async (layout) => {
      virtualStoreLayout = layout;
      await writeCheckoutRuntime(root, beforeSha, layout);
      const target = await advanceRemote();
      const unrelated = path.join(root, "operator-project", "node_modules", "keep.cjs");
      await fs.mkdir(path.dirname(unrelated), { recursive: true });
      await fs.writeFile(unrelated, "operator-owned");
      const result = await update();
      await expectFile(unrelated, "operator-owned");
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(events).toEqual(["build", "validate", "stop", "migrate"]);
      const current = await git(root, "rev-parse", "HEAD");
      expect(result.before?.buildId).toBe(beforeSha);
      expect(result.after).toMatchObject({ sha: current, buildId: current });
      expect(result.gitRuntime).toEqual({
        commit: current,
        distDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(await git(root, "merge-base", current, target)).toBe(target);
      expect.soft(await git(root, "rev-parse", "@{upstream}")).toBe(target);
      await expectRuntime(root, current);
      const manifest: { virtualStoreDir: string } = JSON.parse(
        await readText(path.join(root, "node_modules", ".modules.yaml")),
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
    await expectHead(root, target);
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
    await writeCheckoutRuntime();
    // A deliberately non-signing executable rejects Git's signing request without a key.
    await git(root, "config", "gpg.program", process.execPath);
    await git(root, "config", "commit.gpgSign", "true");
    const abortTimeouts: Array<number | undefined> = [];
    observeCommands((argv, options) => {
      if (argv.includes("rebase") && argv.includes("--abort")) {
        abortTimeouts.push(options.timeoutMs);
      }
    });
    const result = await update();
    // The existing fallback can retain the old candidate without creating a commit.
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(
      result.steps.some((step) => step.name === "preflight-rebase" && step.exitCode !== 0),
    ).toBe(true);
    expect(new Set(abortTimeouts)).toEqual(new Set([5_000]));
    await expectHead(root, beforeSha);
    await expectRuntime(root, beforeSha);
  });

  registerGitRuntimeStagingTests(fixture);

  it("refuses activation when validation commits source outside the selected commit", async () => {
    await fs.writeFile(path.join(remote, "openclaw.mjs"), "throw new Error('broken launcher');\n");
    const target = await advanceRemote();
    const onStepComplete = vi.fn();
    const result = await update({
      devTarget: { mode: "detached", ref: target },
      progress: { onStepComplete },
      validateCandidate: async (candidateRoot) => {
        const launcher = path.join(candidateRoot, "openclaw.mjs");
        await fs.writeFile(launcher, "export {};\n");
        await git(candidateRoot, "add", "openclaw.mjs");
        await git(candidateRoot, "commit", "-m", "repair launcher");
        const probe = await runCommandWithTimeout([process.execPath, launcher], {
          timeoutMs: 5000,
        });
        expect(probe.code).toBe(0);
      },
    });
    expect(
      onStepComplete.mock.calls
        .filter(([step]) => step.name === "preflight-update-clean-check")
        .map(([step]) => step.exitCode),
    ).toEqual([0]);
    expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
    expect(stopped).toBe(false);
    await expectHead(root, beforeSha);
    await expectFile(path.join(root, "openclaw.mjs"), "export {};\n");
    await expectNoRuntimeStagingPaths();
  });

  it.each([
    { restoreSource: true, restoreRuntime: true, timeoutMs: undefined, trackedRuntime: true },
    { restoreSource: false, restoreRuntime: true, timeoutMs: 5_000 },
    { restoreSource: "throw", restoreRuntime: true, timeoutMs: undefined },
    { restoreSource: true, restoreRuntime: false, timeoutMs: undefined },
  ] as const)(
    "verifies runtime recovery after activation failure (source: $restoreSource, runtime: $restoreRuntime)",
    async (scenario) => {
      const { restoreSource, restoreRuntime, timeoutMs } = scenario;
      let trackedAsset: string | undefined;
      if ("trackedRuntime" in scenario) {
        ({ beforeSha, asset: trackedAsset } = await prepareDeletedTrackedRuntimeAsset(
          remote,
          root,
        ));
      }
      await writeCheckoutRuntime();
      const originalCache = path.join(root, "node_modules", ".cache", "jiti", "original.cjs");
      await fs.mkdir(path.dirname(originalCache), { recursive: true });
      await fs.writeFile(originalCache, "original runtime cache");
      const candidateSha = await advanceRemote();
      const command = runCommand;
      let resetFaultInjected = false;
      const rollbackFailure = new Error("rollback command unavailable");
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
            throw rollbackFailure;
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
        const failure = await execution.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({
          cause: rollbackFailure,
          errors: expect.arrayContaining([rollbackFailure]),
        });
        expect(resetFaultInjected).toBe(true);
        expect(onRollbackOutcome).toHaveBeenLastCalledWith({
          status: "failed",
          reason: "Rollback threw before restoration could be verified",
        });
        return;
      }
      const result = await execution;
      expect(new Set(recoveryTimeouts)).toEqual(new Set([5_000]));
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
      await expectHead(root, expectedSha);
      expectStep(result.steps, {
        name: "git-rollback-verify-head",
        exitCode: restoreSource ? 0 : 1,
        stdoutTail: expectedSha,
        ...(restoreSource ? {} : { stderrTail: `expected ${beforeSha}, found ${candidateSha}` }),
      });
      if (!restoreRuntime) {
        assert(distBackup, "The original dist backup was not observed.");
        expect(JSON.parse(await readText(path.join(distBackup, "build-info.json")))).toMatchObject({
          commit: beforeSha,
        });
        expectStep(result.steps, {
          name: "git-runtime-rollback",
          exitCode: 1,
          stderrTail: expect.stringContaining(distBackup),
        });
        return;
      }
      await expectRuntime(root, beforeSha, trackedAsset);
      await expectFile(originalCache, "original runtime cache");
    },
  );

  registerGitRuntimeRestorationTests(fixture);
});
