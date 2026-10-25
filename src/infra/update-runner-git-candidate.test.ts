import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runPackageUpdateDoctor } from "../cli/update-cli/update-command-package.js";
import * as processExec from "../process/exec.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasErrnoCode } from "./errno.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { verifyGitUpdateRecovery } from "./update-git-runtime.js";
import {
  createGitUpdateFixture,
  expectNoGitRuntimeStagingPaths,
  expectRuntime,
  prepareDeletedTrackedRuntimeAsset,
  runFixtureGit as git,
  resolveCandidateNodeRuntimeForTest,
  runtimeImports,
  writeGitFixtureManifest,
  writeFixtureTree,
  type GitUpdateFixture,
  expectHead,
  expectMissing,
  readText,
  expectFile,
  expectStep,
  type GitCandidateFixture,
} from "./update-runner-git-candidate.test-support.js";
import { registerGitActivationDoctorOutcomeTests } from "./update-runner-git-transactions.test-support.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

describe("Git candidate activation", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  const packageMetadata = { openclaw: { schemaVersions: { state: 5, agent: 14 } } };
  let directory: string;
  let root: string;
  let remote: string;
  let state: GitUpdateFixture;
  let inspectedTargets: string[];

  beforeEach(async () => {
    directory = await fs.realpath(directories.make("openclaw-git-candidate-"));
    state = await createGitUpdateFixture(directory, packageMetadata);
    ({ root, remote } = state);
    inspectedTargets = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const advanceRemote = () => state.advanceRemote();

  function observeCommands(observe: (...args: Parameters<CommandRunner>) => void | Promise<void>) {
    const execute = state.runCommand;
    state.runCommand = async (...args) => {
      await observe(...args);
      return execute(...args);
    };
  }

  function update(opts: Partial<UpdateRunnerOptions> = {}) {
    const { prepareGitExposure, runGitDoctor, ...overrides } = opts;
    const runActivationDoctor = async (doctorRoot: string) => {
      expect(state.stopped).toBe(true);
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
      state.events.push("migrate");
      return doctor;
    };
    return state.update({
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
        expect(inspectedTargets).toContain(await git(candidateRoot, "rev-parse", "HEAD"));
        await state.validateCandidate(candidateRoot);
      },
      beforeGitMutation: async (target) => {
        expect(inspectedTargets).toContain(target.sha);
        await state.beforeGitMutation();
      },
      ...overrides,
      ...(prepareGitExposure
        ? { prepareGitExposure }
        : { runGitDoctor: runGitDoctor ?? runActivationDoctor }),
    });
  }

  const expectNoRuntimeStagingPaths = () =>
    expectNoGitRuntimeStagingPaths(root, state.inspectionRoots);
  const writeFiles = (files: Record<string, string>, checkout = root) =>
    writeFixtureTree(checkout, files);
  async function commitFiles(files: Record<string, string>, checkout = root) {
    await writeFiles(files, checkout);
    await git(checkout, "add", ...Object.keys(files));
    await git(checkout, "commit", "-m", "fixture change");
    return git(checkout, "rev-parse", "HEAD");
  }
  async function expectInstalled(sha: string) {
    await expectHead(root, sha);
    await expectRuntime(root, sha);
  }
  async function expectOriginalServing() {
    expect(state.stopped).toBe(false);
    await expectInstalled(state.beforeSha);
    await expectNoRuntimeStagingPaths();
  }

  it("separates work deadlines from observation budgets", async () => {
    await advanceRemote();
    const commands: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    const doctorCommands = vi.spyOn(processExec, "runCommandWithTimeout");
    observeCommands((argv, options) => {
      commands.push({ argv, timeoutMs: options.timeoutMs });
    });
    expect((await update()).status).toBe("ok");
    const doctorOptions = doctorCommands.mock.calls.find(([argv]) => argv.includes("doctor"))?.[1];
    expect(doctorOptions).toBeDefined();
    expect(
      typeof doctorOptions === "number" ? doctorOptions : doctorOptions?.timeoutMs,
    ).toBeUndefined();
    for (const [names, budget] of [
      [["install", "build", "fetch", "checkout"], undefined],
      [["--version", "rev-parse", "status", "remove"], 5_000],
    ] as const) {
      for (const name of names) {
        expect(
          commands.find(({ argv }) => argv.includes(name)),
          name,
        ).toMatchObject({ timeoutMs: budget });
      }
    }
    expect(state.inspectionRoots).not.toHaveLength(0);
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
    expect(names.indexOf("candidate-state-cleanup")).toBeLessThan(
      names.indexOf("preflight-update-clean-check"),
    );
    expectStep(result.steps, {
      name: "git-runtime-activation",
      exitCode: 0,
      durationMs: expect.any(Number),
    });
    expect(names.indexOf("git-runtime-activation")).toBeGreaterThan(names.indexOf("git-checkout"));
  });

  const fixture = (): GitCandidateFixture => ({
    root,
    beforeSha: state.beforeSha,
    events: state.events,
    runCommand: state.runCommand,
    advanceRemote,
    update,
    expectNoRuntimeStagingPaths,
    isStopped: () => state.stopped,
    setRunCommand: (runner) => {
      state.runCommand = runner;
    },
  });
  registerGitActivationDoctorOutcomeTests(fixture);

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

  it.each(["exact", "fallback", "latest"] as const)(
    "qualifies attempted Git candidates before preparation (%s)",
    async (mode) => {
      const compatible = await advanceRemote();
      await writeGitFixtureManifest(remote, {
        ...packageMetadata,
        engines: { node: ">=999.0.0" },
      });
      await git(remote, "add", "package.json");
      const incompatible = await commitFiles({ "next.txt": "incompatible\n" }, remote);
      let selected = compatible;
      if (mode === "latest") {
        await writeGitFixtureManifest(remote, packageMetadata);
        await git(remote, "add", "package.json");
        selected = await commitFiles({ "newest.txt": "compatible\n" }, remote);
      }
      const checkouts: string[] = [];
      observeCommands((argv) => {
        if (argv.includes("checkout") || argv.includes("worktree")) {
          checkouts.push(argv.join(" "));
        }
      });
      const beforeGitStaging = vi.fn<NonNullable<UpdateRunnerOptions["beforeGitStaging"]>>(
        async () => {
          if (mode === "exact") {
            throw new Error("incompatible target reached staging");
          }
          return {
            step: { name: "staging", command: "staging", cwd: root, durationMs: 0, exitCode: 0 },
            failureReason: "snapshot-capacity-insufficient",
          };
        },
      );
      const result = await update({
        ...(mode === "exact" ? { devTarget: { mode: "detached", ref: incompatible } } : {}),
        beforeGitStaging,
      });
      expect(checkouts.every((command) => !command.includes(incompatible))).toBe(true);
      if (mode === "exact") {
        expect(result).toMatchObject({
          status: "error",
          reason: "preflight-node-runtime-incompatible",
        });
        expect(beforeGitStaging).not.toHaveBeenCalled();
        expect(state.events).toEqual([]);
        await expectOriginalServing();
      } else {
        expect(result.status, result.reason).toBe("ok");
        await expectInstalled(selected);
        if (mode === "latest") {
          expect(result.steps.some((step) => step.name === "preflight-node-runtime")).toBe(false);
        }
      }
    },
  );

  it("uses the rebased Node requirement when local commits relax it", async () => {
    await writeGitFixtureManifest(remote, { ...packageMetadata, engines: { node: ">=999.0.0" } });
    await git(remote, "add", "package.json");
    await git(remote, "commit", "-m", "upstream engine");
    await git(root, "fetch", "origin");
    await git(root, "merge", "--ff-only", "origin/main");
    await writeGitFixtureManifest(root, { ...packageMetadata, engines: { node: ">=24.0.0" } });
    await git(root, "add", "package.json");
    await git(root, "commit", "-m", "local engine");
    state.beforeSha = await git(root, "rev-parse", "HEAD");
    await state.writeRuntime();
    await advanceRemote();
    const result = await update();
    expect(result.status, result.reason).toBe("ok");
    expect(JSON.parse(await readText(path.join(root, "package.json"))).engines.node).toBe(
      ">=24.0.0",
    );
  });

  it("rejects after all bounded rebased dev candidates require an incompatible Node runtime", async () => {
    const upstreamBase = state.beforeSha;
    const nodeRuntime = await resolveCandidateNodeRuntimeForTest();
    const requiredMajor = Number.parseInt(nodeRuntime.version.split(".")[0]!, 10) + 1;
    const requiredEngine = `>=${requiredMajor}.0.0`;
    await writeGitFixtureManifest(root, { engines: { node: requiredEngine }, ...packageMetadata });
    await git(root, "add", "package.json");
    await git(root, "commit", "-m", "local change");
    state.beforeSha = await git(root, "rev-parse", "HEAD");
    await state.writeRuntime();

    const olderCandidate = await advanceRemote();
    const latestCandidate = await commitFiles({ "latest.txt": "latest\n" }, remote);

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
    expect(state.events).toEqual([]);
    await expectOriginalServing();
  });

  it.each(["untracked", "head", "branch"] as const)(
    "preserves %s source changes made during validation without stopping the service",
    async (mutation) => {
      await advanceRemote();
      const result = await update({
        validateCandidate: async () => {
          if (mutation === "untracked") {
            await writeFiles({ "dist.openclaw-update-operator.tmp/keep.txt": "keep this change" });
          } else if (mutation === "head") {
            await commitFiles({ "operator-change.txt": "committed change" });
          } else {
            await git(root, "checkout", "-b", "operator-branch");
          }
        },
      });
      expect(result).toMatchObject({ status: "error", reason: "dirty" });
      expect(state.stopped).toBe(false);
      if (mutation === "untracked") {
        await expectFile(
          path.join(root, "dist.openclaw-update-operator.tmp", "keep.txt"),
          "keep this change",
        );
      } else if (mutation === "head") {
        expect(await git(root, "rev-parse", "HEAD")).not.toBe(state.beforeSha);
      } else {
        expect(await git(root, "branch", "--show-current")).toBe("operator-branch");
      }
      if (mutation !== "head") {
        await expectHead(root, state.beforeSha);
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
      state.beforeSha = await git(root, "rev-parse", "HEAD");
      await state.writeRuntime(root, state.beforeSha, operatorStore);
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
      const command = state.runCommand;
      state.runCommand = async (argv, options) => {
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
        await fs.rm(path.join(store, state.beforeSha), { recursive: true, force: true });
        await state.writeRuntime(cwd, await git(cwd, "rev-parse", "HEAD"), store);
        if (argv[1] === "build") {
          await fs.rm(path.join(cwd, "dist", "control-ui", "index.html"));
          if (dirtyWorkspace) {
            await fs.appendFile(
              path.join(cwd, "pnpm-workspace.yaml"),
              "# build changed this file\n",
            );
          }
        }
        expect(state.stopped).toBe(false);
        await expectRuntime(root, state.beforeSha);
        state.events.push(argv[1]!);
        return { code: 0, stdout: "", stderr: "" };
      };
      const result = await update({
        devTarget: { mode: "detached", ref: target },
        prepareGitExposure: async (cwd, sha, env) => {
          expect(sha).toBe(target);
          expect(env).toBeDefined();
          await state.runCommand(["pnpm", "install"], { cwd, env });
          state.events.push("exposure");
        },
        beforeGitMutation: async (candidate) => {
          expect(candidate.sha).toBe(target);
          expect(inspectedTargets).toContain(target);
          await expectRuntime(root, state.beforeSha);
          await expectFile(path.join(root, "pnpm-workspace.yaml"), workspace);
          state.stopped = true;
          state.events.push("stop");
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
        expect(state.events).toEqual(candidateEvents);
        await expectOriginalServing();
        return;
      }
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(state.events).toEqual([...candidateEvents, "stop"]);
      await expectInstalled(target);
      const manifest = YAML.parse(await readText(path.join(root, "node_modules", ".modules.yaml")));
      expect(path.resolve(root, "node_modules", manifest.virtualStoreDir)).toBe(
        path.join(root, "node_modules", ".pnpm"),
      );
    },
  );

  it.each(["cache/deps", "../store", "external", "symlink", "source-current"] as const)(
    "activates the validated runtime from %s",
    async (layout) => {
      const stale = layout === "source-current";
      const builtSha = state.beforeSha;
      state.virtualStoreLayout = stale ? "node_modules/.pnpm" : layout;
      await state.writeRuntime();
      const target = await advanceRemote();
      if (stale) {
        await git(remote, "tag", "v2026.9.1");
        await git(root, "pull", "--ff-only");
        state.beforeSha = target;
        await fs.writeFile(
          path.join(root, "dist/build-info.json"),
          JSON.stringify({ buildId: builtSha }),
        );
        await expectRuntime(root, builtSha);
      }
      const unrelated = path.join(root, "operator-project", "node_modules", "keep.cjs");
      await writeFiles({ "operator-project/node_modules/keep.cjs": "operator-owned" });
      const result = await update({
        beforeGitMutation: async (candidate) => {
          expect(inspectedTargets).toContain(candidate.sha);
          await expectRuntime(root, builtSha);
          await state.beforeGitMutation();
        },
      });
      await expectFile(unrelated, "operator-owned");
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(state.events).toEqual(["build", "validate", "stop", "migrate"]);
      const current = await git(root, "rev-parse", "HEAD");
      expect(result.before).toMatchObject({ sha: state.beforeSha, buildId: builtSha });
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
            : path.resolve(root, state.virtualStoreLayout);
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
      if (stale) {
        expect(current).toBe(target);
        state.stopped = false;
        state.events.length = 0;
        expect(await update()).toMatchObject({
          status: "skipped",
          reason: "already-current",
          before: { sha: target, buildId: target },
        });
        expect(state.events).toEqual([]);
        await expectOriginalServing();
      }
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
    expect(await git(root, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
      "refs/heads/operator-target",
    );
    await expectInstalled(target);
  });

  it("preserves required signatures when a candidate rebase fails", async () => {
    await advanceRemote();
    state.beforeSha = await commitFiles({ "local.txt": "operator change\n" });
    await state.writeRuntime();
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
    await expectInstalled(state.beforeSha);
  });

  it("refuses activation when validation commits source outside the selected commit", async () => {
    await fs.writeFile(path.join(remote, "openclaw.mjs"), "throw new Error('broken launcher');\n");
    const target = await advanceRemote();
    const onStepComplete = vi.fn();
    const result = await update({
      devTarget: { mode: "detached", ref: target },
      progress: { onStepComplete },
      validateCandidate: async (candidateRoot) => {
        const launcher = path.join(candidateRoot, "openclaw.mjs");
        await commitFiles({ "openclaw.mjs": "export {};\n" }, candidateRoot);
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
    await expectOriginalServing();
    await expectFile(path.join(root, "openclaw.mjs"), "export {};\n");
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
        ({ beforeSha: state.beforeSha, asset: trackedAsset } =
          await prepareDeletedTrackedRuntimeAsset(remote, root));
      }
      await state.writeRuntime();
      const originalCache = path.join(root, "node_modules", ".cache", "jiti", "original.cjs");
      await writeFiles({ "node_modules/.cache/jiti/original.cjs": "original runtime cache" });
      const candidateSha = await advanceRemote();
      const command = state.runCommand;
      let resetFaultInjected = false;
      const rollbackFailure = new Error("rollback command unavailable");
      const recoveryTimeouts: Array<number | undefined> = [];
      state.runCommand = async (argv, options) => {
        if (faultInjected && argv[0] === "git" && argv[2] === root) {
          recoveryTimeouts.push(options.timeoutMs);
        }
        if (
          restoreSource !== true &&
          argv[0] === "git" &&
          argv[2] === root &&
          argv[3] === "reset" &&
          argv[4] === "--hard" &&
          argv[5] === state.beforeSha
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
          await writeFixtureTree(destination, { "restore-race": "occupied" });
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
      expect({ faultInjected, resetFaultInjected, restoreFaultInjected }).toEqual({
        faultInjected: true,
        resetFaultInjected: !restoreSource,
        restoreFaultInjected: !restoreRuntime,
      });
      expect(result).toMatchObject({
        status: "error",
        recovery: !restoreSource
          ? { serviceRestartSafe: false, reason: "source-rollback-failed" }
          : restoreRuntime
            ? { serviceRestartSafe: true, buildId: state.beforeSha }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      expect(state.events).toEqual(["build", "validate", "stop"]);
      const expectedSha = restoreSource ? state.beforeSha : candidateSha;
      await expectHead(root, expectedSha);
      expectStep(result.steps, {
        name: "git-rollback-verify-head",
        exitCode: restoreSource ? 0 : 1,
        stdoutTail: expectedSha,
        ...(restoreSource
          ? {}
          : { stderrTail: `expected ${state.beforeSha}, found ${candidateSha}` }),
      });
      if (!restoreRuntime) {
        assert(distBackup, "The original dist backup was not observed.");
        expect(JSON.parse(await readText(path.join(distBackup, "build-info.json")))).toMatchObject({
          commit: state.beforeSha,
        });
        expectStep(result.steps, {
          name: "git-runtime-rollback",
          exitCode: 1,
          stderrTail: expect.stringContaining(distBackup),
        });
        return;
      }
      await expectRuntime(root, state.beforeSha, trackedAsset);
      await expectFile(originalCache, "original runtime cache");
    },
  );

  it("omits generated tool caches while preserving runtime files during promotion", async () => {
    const target = await advanceRemote();
    const stagingProgress: string[] = [];
    const contents = "keep or regenerate";
    const copy = fs.cp.bind(fs);
    vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
      if (String(args[1]).includes(".openclaw-update-")) {
        expect(stagingProgress).toEqual(["start"]);
        expect(state.stopped).toBe(false);
      }
      return copy(...args);
    });
    const omitted = [
      "node_modules/.cache/jiti",
      "node_modules/.vite",
      "node_modules/.vite-temp",
      "ui/node_modules/.cache/jiti",
    ];
    const retained = [
      "node_modules/.cache/other-tool",
      "node_modules/package/.cache/jiti",
      "node_modules/package/.vite",
      "packages/runtime/node_modules/.cache/jiti",
      "dist/.cache/jiti",
      "dist-runtime/.vite",
    ];
    const markStage =
      (event: string) =>
      ({ name }: { name: string }) => {
        if (name === "preflight-runtime-stage") {
          stagingProgress.push(event);
        }
      };
    const result = await update({
      progress: {
        onStepStart: markStage("start"),
        onStepComplete: markStage("complete"),
      },
      validateCandidate: async (candidateRoot) => {
        await writeFixtureTree(
          candidateRoot,
          Object.fromEntries(
            [...omitted, ...retained].map((relative) => [`${relative}/content`, contents]),
          ),
        );
        await expectRuntime(candidateRoot, target);
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(stagingProgress).toEqual(["start", "complete"]);
    expectStep(result.steps, {
      name: "preflight-runtime-stage",
      exitCode: 0,
      durationMs: expect.any(Number),
    });
    for (const relative of omitted) {
      await expectMissing(path.join(root, relative));
    }
    for (const relative of retained) {
      await expectFile(path.join(root, relative, "content"), contents);
    }
    await expectRuntime(root, target);
    await expectNoRuntimeStagingPaths();
  });

  it.each(["validation", "runtime staging"])(
    "leaves the old runtime serving when candidate %s fails",
    async (failurePoint) => {
      await advanceRemote();
      const failure = new Error("candidate canary failed");
      const onStepComplete = vi.fn();
      const cause: unknown = await update({
        progress: {
          onStepComplete,
          onStepStart: ({ name }) => {
            if (failurePoint === "runtime staging" && name === "preflight-cleanup") {
              expect(onStepComplete).toHaveBeenCalledWith(
                expect.objectContaining({
                  name: "preflight-runtime-stage",
                  exitCode: 1,
                  failureFacts: [expect.objectContaining({ check: "preflight-runtime-stage" })],
                }),
              );
            }
          },
        },
        validateCandidate: async () => {
          if (failurePoint === "validation") {
            throw failure;
          }
          vi.spyOn(fs, "cp").mockRejectedValueOnce(failure);
        },
      }).catch((error: unknown) => error);
      if (failurePoint === "validation") {
        expect(cause).toBe(failure);
      } else {
        const { resolveMutableUpdateFailure } =
          await import("../cli/update-cli/update-command-result.js");
        const { result } = await resolveMutableUpdateFailure({
          cause,
          durationMs: 0,
          mode: "git",
          root,
          originalRecovery: () => verifyGitUpdateRecovery({ root, sha: state.beforeSha }),
        });
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: true,
          buildId: state.beforeSha,
        });
      }
      await expectOriginalServing();
    },
  );
});
