import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture(relativeRemote = false, partialClone = false) {
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
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Update fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\ndist/\n.artifacts/\n");
  fs.writeFileSync(path.join(source, "openclaw.mjs"), "export {};\n");
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
    return git(source, "rev-parse", "HEAD");
  };
  commit("2026.7.1", 13);
  if (partialClone) {
    git(source, "config", "uploadpack.allowFilter", "true");
    git(root, "clone", "--filter=blob:none", pathToFileURL(source).href, install);
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
    if (argv.includes("doctor") && argv[0] === (await resolveStableNodePath(process.execPath))) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "pnpm") {
      if (argv.includes("build")) {
        const dist = path.join(options.cwd!, "dist");
        fs.mkdirSync(path.join(dist, "control-ui"), { recursive: true });
        fs.writeFileSync(path.join(dist, "entry.js"), "export {};\n");
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
      timeout: 15_000,
    });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const run = (options: UpdateRunnerOptions, command: CommandRunner = runCommand) =>
    updateGitCheckout({
      gitRoot: install,
      runCommand: command,
      defaultCommandEnv: env,
      timeoutMs: 15_000,
      startedAt: Date.now(),
      opts: { channel: "stable", inspectGitTarget: async () => undefined, ...options },
    });
  return { root, source, install, globalConfig, git, commit, target, calls, runCommand, run };
}

function snapshotTree(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .toSorted()
    .flatMap((name) => {
      const fullPath = path.join(root, name);
      const stat = fs.lstatSync(fullPath);
      return stat.isFile()
        ? [
            `${name} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")}`,
          ]
        : stat.isSymbolicLink()
          ? [`${name} -> ${fs.readlinkSync(fullPath)}`]
          : [];
    });
}

describe("Git database admission", () => {
  it.each([
    { channel: "stable", publish: false, downgrade: false },
    { channel: "dev", publish: false, downgrade: false },
    { channel: "stable", publish: true, downgrade: false },
    { channel: "dev", publish: false, downgrade: true },
  ] as const)(
    "activates a partial clone without upstream access after admission ($channel, publish=$publish, downgrade=$downgrade)",
    async ({ channel, publish, downgrade }) => {
      const state = fixture(false, true);
      const published = path.join(state.root, "published");
      const target = downgrade
        ? state.git(state.source, "rev-parse", "v2026.7.2-beta.1")
        : state.target;
      if (downgrade) {
        state.git(state.install, "fetch", "upstream.with.dots");
        state.git(state.install, "checkout", "--detach", state.target);
      }
      const admission = vi.fn(async () => {
        // Activation must consume staged objects, even if upstream goes offline.
        fs.renameSync(state.source, `${state.source}.offline`);
      });
      const result = await state.run({
        channel,
        ...(downgrade ? { devTarget: { mode: "detached" as const, ref: target } } : {}),
        beforeGitMutation: admission,
        ...(publish
          ? {
              publishGitCheckout: async () => {
                fs.renameSync(state.install, published);
                return published;
              },
            }
          : {}),
      });
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(admission).toHaveBeenCalledOnce();
      const installed = publish ? published : state.install;
      expect(state.git(installed, "rev-parse", "HEAD")).toBe(target);
      expect(
        JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")),
      ).toMatchObject({
        version: downgrade ? "2026.7.2-beta.1" : "2026.7.2",
      });
    },
  );

  it.each([false, true])(
    "retains the imported pack through repack before checkout (publish=%s)",
    async (publish) => {
      const state = fixture();
      const published = path.join(state.root, "published");
      let repacked = false;
      const command: CommandRunner = async (argv, options) => {
        const result = await state.runCommand(argv, options);
        if (argv[2] === state.install && argv[3] === "index-pack" && result.code === 0) {
          state.git(state.install, "repack", "-a", "-d");
          repacked = true;
          expect(state.git(state.install, "cat-file", "-t", state.target)).toBe("commit");
        }
        return result;
      };
      const result = await state.run(
        {
          beforeGitMutation: async () => undefined,
          ...(publish
            ? {
                publishGitCheckout: async () => {
                  fs.renameSync(state.install, published);
                  return published;
                },
              }
            : {}),
        },
        command,
      );
      const installed = publish ? published : state.install;
      expect(repacked).toBe(true);
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(state.git(installed, "rev-parse", "HEAD")).toBe(state.target);
      const packs = path.join(installed, ".git", "objects", "pack");
      expect(fs.readdirSync(packs).filter((name) => name.endsWith(".keep"))).toEqual([]);
    },
  );

  it("does not release another owner's keep file after import", async () => {
    const state = fixture();
    let keepPath = "";
    const command: CommandRunner = async (argv, options) => {
      if (argv[2] === state.install && argv[3] === "index-pack") {
        const pack = options.input as Buffer;
        const hash = pack.subarray(-20).toString("hex");
        keepPath = path.join(state.install, ".git", "objects", "pack", `pack-${hash}.keep`);
        fs.writeFileSync(keepPath, "operator retention\n");
      }
      return state.runCommand(argv, options);
    };
    const result = await state.run({ beforeGitMutation: async () => undefined }, command);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(fs.readFileSync(keepPath, "utf8")).toBe("operator retention\n");
  });

  it("stages divergent history blobs and delta bases before taking upstream offline", async () => {
    const state = fixture(false, true);
    const historical = Array.from({ length: 2000 }, (_, index) =>
      createHash("sha256").update(`history-${index}`).digest("hex"),
    ).join("\n");
    fs.writeFileSync(path.join(state.source, "changed.txt"), historical);
    fs.writeFileSync(path.join(state.source, "unchanged.txt"), historical);
    const base = state.commit("2026.7.3", 14);
    fs.writeFileSync(path.join(state.source, "changed.txt"), "installed replacement\n");
    fs.writeFileSync(path.join(state.source, "unchanged.txt"), "installed replacement\n");
    const installed = state.commit("2026.7.4", 14);
    state.git(state.install, "fetch", "upstream.with.dots");
    state.git(state.install, "checkout", "--detach", installed);
    state.git(state.source, "checkout", "-b", "fixture-target", base);
    fs.writeFileSync(path.join(state.source, "changed.txt"), `${historical}\ncandidate edit\n`);
    const target = state.commit("2026.7.5", 14);
    const admission = vi.fn(async () => {
      // The installed partial clone has neither this historical blob nor its delta base.
      fs.renameSync(state.source, `${state.source}.offline`);
    });
    const result = await state.run({
      channel: "dev",
      devTarget: { mode: "detached", ref: target },
      beforeGitMutation: admission,
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(admission).toHaveBeenCalledOnce();
    expect(state.git(state.install, "rev-parse", "HEAD")).toBe(target);
    expect(fs.readFileSync(path.join(state.install, "changed.txt"), "utf8")).toBe(
      `${historical}\ncandidate edit\n`,
    );
    expect(fs.readFileSync(path.join(state.install, "unchanged.txt"), "utf8")).toBe(historical);
  });

  it.each([
    ...(["staging", "import"] as const).flatMap((phase) =>
      [false, true].map((validRuntime) => ({ phase, validRuntime, sourceChanged: false })),
    ),
    { phase: "import" as const, validRuntime: true, sourceChanged: true },
  ])(
    "preserves the retained runtime on $phase failure (validRuntime=$validRuntime, sourceChanged=$sourceChanged)",
    async ({ phase, validRuntime, sourceChanged }) => {
      const state = fixture();
      const beforeSha = state.git(state.install, "rev-parse", "HEAD");
      const dist = path.join(state.install, "dist");
      fs.mkdirSync(path.join(dist, "control-ui"), { recursive: true });
      fs.writeFileSync(path.join(dist, "entry.js"), "export const retained = true;\n");
      fs.writeFileSync(path.join(dist, "control-ui", "index.html"), "retained UI\n");
      fs.writeFileSync(
        path.join(dist, "build-info.json"),
        JSON.stringify({ commit: beforeSha, buildId: "retained-build" }),
      );
      for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
        fs.writeFileSync(path.join(dist, name), JSON.stringify({ head: beforeSha }));
      }
      if (!validRuntime) {
        fs.rmSync(path.join(dist, ".runtime-postbuildstamp"));
      }
      const beforeRuntime = snapshotTree(dist);
      const admission = vi.fn(async () => undefined);
      const command: CommandRunner = async (argv, options) => {
        const fail =
          phase === "staging"
            ? argv.includes("pack-objects")
            : argv[2] === state.install && argv[3] === "index-pack";
        if (argv[0] === "git" && fail) {
          expect(admission).toHaveBeenCalledTimes(phase === "staging" ? 0 : 1);
          if (sourceChanged) {
            fs.appendFileSync(path.join(state.install, "package.json"), "\n");
          }
          return { code: 128, stdout: "", stderr: "synthetic target transport failure" };
        }
        return state.runCommand(argv, options);
      };
      const result = await state.run({ beforeGitMutation: admission }, command);
      expect(result).toMatchObject({
        status: "error",
        reason: "fetch-failed",
        recovery:
          validRuntime && !sourceChanged
            ? { serviceRestartSafe: true, version: "2026.7.1", buildId: "retained-build" }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      expect(admission).toHaveBeenCalledTimes(phase === "staging" ? 0 : 1);
      expect(state.git(state.install, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(snapshotTree(dist)).toEqual(beforeRuntime);
    },
  );

  it("finishes with a recorded warning when inspection clone cleanup fails", async () => {
    const state = fixture();
    const remove = fsPromises.rm.bind(fsPromises);
    let retained: string | undefined;
    const denial = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (
        typeof target === "string" &&
        path.basename(target).startsWith("openclaw-git-admission-")
      ) {
        retained = target;
        throw new Error("synthetic inspection cleanup denied");
      }
      return remove(target, options);
    });
    try {
      const onStepComplete = vi.fn();
      const result = await state.run({
        beforeGitMutation: async () => undefined,
        progress: { onStepComplete },
      });
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
      expect(onStepComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "git target inspection cleanup",
          advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
        }),
      );
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "git target inspection cleanup",
          advisory: expect.objectContaining({
            message: expect.stringContaining("synthetic inspection cleanup denied"),
          }),
        }),
      );
      expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
        "inspection cleanup",
      );
    } finally {
      denial.mockRestore();
      if (retained) {
        await remove(retained, { recursive: true, force: true });
      }
    }
  });
  it("preserves dev upstream setup from a cold tracking inventory", async () => {
    const state = fixture();
    state.git(state.install, "checkout", "-b", "maintenance");
    state.git(state.install, "branch", "-D", "main");
    state.git(state.install, "update-ref", "-d", "refs/remotes/upstream.with.dots/main");
    let restoredUpstream = false;
    const command: CommandRunner = async (argv, options) => {
      const result = await state.runCommand(argv, options);
      if (argv[2] === state.install && argv[3] === "branch" && argv[4] === "--set-upstream-to") {
        expect(result.code, result.stderr).toBe(0);
        expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
        expect(state.git(state.install, "rev-parse", "main@{upstream}")).toBe(state.target);
        restoredUpstream = true;
      }
      return result;
    };
    const result = await state.run(
      { channel: "dev", beforeGitMutation: async () => undefined },
      command,
    );
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(restoredUpstream).toBe(true);
  });

  it.each(
    (["stable", "dev"] as const).flatMap((channel) =>
      [false, true].map((admitted) => ({ channel, admitted })),
    ),
  )(
    "rechecks admission after transport ($channel, admitted=$admitted)",
    async ({ channel, admitted }) => {
      const state = fixture();
      let checkoutObserved = false;
      let admissionFinished = false;
      let admissionFresh = false;
      const remoteFetches: boolean[] = [];
      const command: CommandRunner = async (argv, options) => {
        if (argv[2] === state.install && (argv[3] === "fetch" || argv[3] === "index-pack")) {
          remoteFetches.push(admissionFinished);
          admissionFresh = false;
        }
        if (argv[2] === state.install && (argv[3] === "checkout" || argv[3] === "rebase")) {
          expect(remoteFetches).toEqual([admitted]);
          if (admitted) {
            expect(admissionFresh).toBe(true);
          }
          expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
            '"agent":14',
          );
          checkoutObserved = true;
        }
        return state.runCommand(argv, options);
      };
      const result = await state.run(
        {
          channel,
          ...(admitted
            ? {
                beforeGitMutation: async () => {
                  admissionFinished = true;
                  admissionFresh = true;
                },
                inspectGitTarget: async () => {
                  if (admissionFinished) {
                    admissionFresh = true;
                  }
                },
              }
            : {}),
        },
        command,
      );
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(checkoutObserved).toBe(true);
    },
  );

  it.each(
    (["global", "command"] as const).flatMap((configuration) =>
      [false, true].map((configured) => ({ configuration, configured })),
    ),
  )(
    "uses captured transport configuration ($configuration, configured=$configured)",
    async ({ configuration, configured }) => {
      const state = fixture();
      const unresolved = pathToFileURL(path.join(state.root, "absent-remote")).href;
      const key = `url.${pathToFileURL(state.source).href}.insteadOf`;
      state.git(state.install, "remote", "set-url", "upstream.with.dots", unresolved);
      if (configuration === "global" && configured) {
        state.git(state.install, "config", "--file", state.globalConfig, key, unresolved);
      }
      const captured = await withEnvAsync(
        {
          GIT_CONFIG_GLOBAL: state.globalConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_CONFIG_COUNT: configuration === "command" && configured ? "1" : "0",
          GIT_CONFIG_KEY_0: configuration === "command" && configured ? key : undefined,
          GIT_CONFIG_VALUE_0: configuration === "command" && configured ? unresolved : undefined,
        },
        () => buildUpdateCommandRunner(),
      );
      const before = snapshotTree(state.install);
      const refused = new Error("refuse after effective-environment transport");
      const admission = vi.fn(async (target) => {
        expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
        throw refused;
      });
      const result = updateGitCheckout({
        gitRoot: state.install,
        ...captured,
        timeoutMs: 15_000,
        startedAt: Date.now(),
        opts: { channel: "stable", inspectGitTarget: admission },
      });
      if (configured) {
        await expect(result).rejects.toBe(refused);
        expect(admission).toHaveBeenCalledOnce();
      } else {
        await expect(result).resolves.toMatchObject({ status: "error", reason: "fetch-failed" });
        expect(admission).not.toHaveBeenCalled();
      }
      expect(snapshotTree(state.install)).toEqual(before);
    },
  );

  it.each([false, true])(
    "checks development admission before target scripts, refuseFirst=%s",
    async (refuseFirst) => {
      const state = fixture();
      state.commit("2026.7.3", 15);
      const before = snapshotTree(state.install);
      const refused = new Error("fallback database refusal");
      const builds: string[] = [];
      const inspected: number[] = [];
      const runCommand: CommandRunner = async (argv, options) => {
        if (argv[0] === "git") {
          return state.runCommand(argv, options);
        }
        if (argv.includes("build")) {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(options.cwd!, "package.json"), "utf8"),
          );
          builds.push(manifest.version);
          if (!refuseFirst && manifest.version === "2026.7.3") {
            return { code: 1, stdout: "", stderr: "synthetic candidate build failure" };
          }
        }
        return state.runCommand(argv, options);
      };
      await expect(
        state.run(
          {
            channel: "dev",
            inspectGitTarget: async (target) => {
              inspected.push(target.schemaVersions!.agent);
              if (refuseFirst) {
                expect(target).toEqual({ schemaVersions: { state: 5, agent: 15 } });
                throw refused;
              }
            },
            beforeGitMutation: async (target) => {
              expect(target).toEqual({
                schemaVersions: { state: 5, agent: 14 },
              });
              throw refused;
            },
          },
          runCommand,
        ),
      ).rejects.toBe(refused);
      expect(builds).toEqual(refuseFirst ? [] : ["2026.7.3", "2026.7.2"]);
      expect([...new Set(inspected)]).toEqual(refuseFirst ? [15] : [15, 14]);
      expect(snapshotTree(state.install)).toEqual(before);
    },
  );

  it("fetches through a repository-local SSH command with an explicit dialect", async () => {
    const state = fixture();
    const wrapper = path.join(state.root, "ssh-wrapper.mjs");
    const transportLog = path.join(state.root, "ssh-calls.jsonl");
    fs.writeFileSync(
      wrapper,
      `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify(args) + "\\n");
if (args[0] !== "-P" || args[1] !== "22445" || args[2] !== "fixture.invalid") process.exit(91);
if (!args[3]?.startsWith("git-upload-pack ")) process.exit(92);
const result = spawnSync("git", ["upload-pack", ${JSON.stringify(state.source)}], { stdio: "inherit" });
process.exit(result.status ?? 93);
`,
    );
    const quote = (value: string) => `"${value.replaceAll("\\", "/")}"`;
    state.git(
      state.install,
      "config",
      "core.sshCommand",
      `${quote(process.execPath)} ${quote(wrapper)}`,
    );
    state.git(state.install, "config", "ssh.variant", "plink");
    const remote = new URL("ssh://fixture.invalid:22445");
    remote.pathname = state.source;
    state.git(state.install, "remote", "set-url", "upstream.with.dots", remote.href);
    // The installed repository can reach the fixture with this command/dialect pair.
    expect(
      state.git(state.install, "ls-remote", "upstream.with.dots", "refs/heads/main"),
    ).toContain(state.target);
    const before = snapshotTree(state.install);
    const refused = new Error("stop after real SSH transport and target admission");
    await expect(
      state.run({
        inspectGitTarget: async () => {
          throw refused;
        },
      }),
    ).rejects.toBe(refused);
    const calls = fs
      .readFileSync(transportLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((args) => args[0] === "-P" && args[1] === "22445")).toBe(true);
    expect(snapshotTree(state.install)).toEqual(before);
  });

  it("keeps the admitted target pinned when its remote advances", async () => {
    const state = fixture();
    let checkoutObserved = false;
    const admission = vi.fn(async (target) => {
      expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
      state.commit("2026.7.3", 15);
    });
    const command: CommandRunner = async (argv, options) => {
      if (argv[0] === "git" && argv[2] === state.install && argv[3] === "checkout") {
        expect(argv.at(-1)).toBe(state.target);
        expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
          '"agent":14',
        );
        checkoutObserved = true;
      }
      return state.runCommand(argv, options);
    };
    const result = await state.run({ beforeGitMutation: admission }, command);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(checkoutObserved).toBe(true);
    expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
    expect(admission).toHaveBeenCalledOnce();
  });

  it.each([false, true])("publishes only an admitted checkout (refuse=%s)", async (refuse) => {
    const state = fixture();
    const published = path.join(state.root, "published");
    const complete = new Error("refuse publication");
    const publish = vi.fn(async () => {
      expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
        '"agent":14',
      );
      fs.renameSync(state.install, published);
      return published;
    });
    const result = state.run({
      beforeGitMutation: async (target) => {
        expect(fs.existsSync(published)).toBe(false);
        expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
        if (refuse) {
          throw complete;
        }
      },
      publishGitCheckout: publish,
    });
    if (refuse) {
      await expect(result).rejects.toBe(complete);
    } else {
      await expect(result).resolves.toMatchObject({
        status: "ok",
        root: published,
        after: { sha: state.target },
      });
    }
    expect(publish).toHaveBeenCalledTimes(refuse ? 0 : 1);
    expect(fs.existsSync(published)).toBe(!refuse);
  });
  it.each([false, true])(
    "refuses before installed Git writes (relative remote=%s)",
    async (relative) => {
      const state = fixture(relative);
      // Unchanged content with a stale index stat cache must remain read-only too.
      fs.utimesSync(path.join(state.install, "package.json"), new Date(1000), new Date(1000));
      const before = snapshotTree(state.install);
      const refusal = new Error("incompatible database");
      const inspect = vi.fn(async (target) => {
        expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
        throw refusal;
      });
      await expect(state.run({ inspectGitTarget: inspect })).rejects.toBe(refusal);
      expect(inspect).toHaveBeenCalledOnce();
      expect(snapshotTree(state.install)).toEqual(before);
      const mirror = state.calls.find((argv) => argv.includes("clone"))?.at(-1);
      expect(mirror).toBeDefined();
      expect(fs.existsSync(mirror!)).toBe(false);
    },
  );
});
