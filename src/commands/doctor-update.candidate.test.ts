import "./doctor-update.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-context-types.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../infra/update-managed-service-handoff-lease.js";
import type { CommandRunner, UpdateRunnerOptions } from "../infra/update-runner-types.js";

vi.unmock("../daemon/gateway-entrypoint.js");

const { installDoctorUpdateTestHooks, mocks, runOffer } =
  await import("./doctor-update.test-support.js");
installDoctorUpdateTestHooks();
const dirs = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
});
const actualExec = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
const actualRunner = await vi.importActual<typeof import("../infra/update-runner.js")>(
  "../infra/update-runner.js",
);

const actualRecovery = await vi.importActual<
  typeof import("../cli/update-cli/update-command-service-recovery.js")
>("../cli/update-cli/update-command-service-recovery.js");

async function git(root: string, ...args: string[]) {
  const result = await actualExec.runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

it.each([
  { name: "unsupported candidate", supported: false, valid: true },
  { name: "supported candidate", supported: true, valid: true },
  { name: "invalid candidate config", supported: true, valid: false },
  { name: "non-native candidate", supported: false, valid: true, native: false },
  { name: "missing original owner before probe", supported: true, valid: true, fault: "before" },
  { name: "revoked original owner after probe", supported: true, valid: true, fault: "after" },
])(
  "admits the $name before the first native stop",
  async ({ supported, valid, native = true, fault }) => {
    const directory = await fs.realpath(dirs.make("doctor-candidate-"));
    const remote = path.join(directory, "remote");
    const root = path.join(directory, "installed");
    // The public entry runs from the disposable installed CLI, not Vitest itself.
    process.argv = [process.execPath, path.join(root, "openclaw.mjs")];
    const eventsPath = path.join(directory, "events.jsonl");
    const stateDir = path.join(directory, "state");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    const revokeOriginal = () => {
      expect(createManagedHandoffLeaseStore().read(root).kind).toBe("current");
      const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
      try {
        if (fault === "before") {
          db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(root);
        } else {
          db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
            "revoked",
            root,
          );
        }
      } finally {
        db.close();
      }
    };
    const originalRun = {
      runId: "3d065cd3-ffde-4163-970c-5e0c0f1d8251",
      env,
    };
    mocks.admitUpdateCommandRun.mockResolvedValue(originalRun);
    mocks.maybeRestartServiceAfterFailedMutableUpdate.mockImplementation(
      actualRecovery.maybeRestartServiceAfterFailedMutableUpdate,
    );
    await fs.mkdir(remote);
    await fs.mkdir(stateDir);
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ fixtureValid: valid }));
    await fs.writeFile(eventsPath, "");
    await git(remote, "init", "--initial-branch=main");
    await git(remote, "config", "user.name", "OpenClaw Test");
    await git(remote, "config", "user.email", "openclaw@example.com");
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        type: "module",
        packageManager: "pnpm@12.0.0",
      }),
    );
    await fs.writeFile(path.join(remote, ".gitignore"), "node_modules/\ndist/\n.artifacts/\n");
    const fixture = `
    import fs from 'node:fs';
    const event = (phase) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({phase,root:process.cwd(),config:process.env.OPENCLAW_CONFIG_PATH})+'\\n');
    if (process.argv.includes('--update-executor')) {
      process.stdin.resume();
      process.stdin.on('end', () => {
        event('capability');
        process.stdout.write(JSON.stringify({updateExecutor:'root-spawner-v1',targetRootBinding:${supported}}));
      });
    } else if (process.argv.includes('config')) {
      event('config');
      const config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
      process.stdout.write(JSON.stringify({valid:config.fixtureValid}));
      process.exitCode=config.fixtureValid?0:1;
    }
  `;
    await fs.writeFile(path.join(remote, "openclaw.mjs"), fixture);
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "base fixture");
    const beforeSha = await git(remote, "rev-parse", "HEAD");
    await git(directory, "clone", "--quiet", remote, root);
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    const writeRuntime = async (target: string, sha: string) => {
      await fs.mkdir(path.join(target, "dist", "control-ui"), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(target, "dist", "index.js"), fixture),
        fs.writeFile(path.join(target, "dist", "entry.js"), fixture),
        fs.writeFile(path.join(target, "dist", "control-ui", "index.html"), "ready"),
        fs.writeFile(
          path.join(target, "dist", "build-info.json"),
          JSON.stringify({ commit: sha, buildId: sha }),
        ),
        fs.writeFile(path.join(target, "dist", ".buildstamp"), JSON.stringify({ head: sha })),
        fs.writeFile(
          path.join(target, "dist", ".runtime-postbuildstamp"),
          JSON.stringify({ head: sha }),
        ),
      ]);
    };
    await writeRuntime(root, beforeSha);
    await fs.writeFile(path.join(remote, "candidate.txt"), "new revision\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "candidate fixture");
    const candidateSha = await git(remote, "rev-parse", "HEAD");
    const reachedStop = new Error("test stops at native preparation boundary");
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockImplementation(async (params) => {
      if (params.phase === "prepare") {
        expect(params.updateRun).toBe(originalRun);
        params.updateRun.executorFence.assertCurrent();
        await fs.appendFile(
          eventsPath,
          JSON.stringify({ phase: native ? "stop" : "prepare", root }) + "\n",
        );
        if (native) {
          throw reachedStop;
        }
      }
      return {
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: native,
        serviceEnv: env,
        serviceUpdateVerdict: native
          ? { kind: "owned", root, refreshDefinition: false, fingerprint: "original" }
          : { kind: "absent" },
      } satisfies PreManagedServiceStop;
    });
    let originalOwner:
      | ReturnType<ReturnType<typeof createManagedHandoffLeaseStore>["read"]>
      | undefined;
    mocks.runCommandWithTimeout.mockImplementation(async (argv, options) => {
      if (argv.includes("--update-executor")) {
        const run = await mocks.admitUpdateCommandRun.mock.results[0]!.value;
        expect(run).toBe(originalRun);
        // Registration suspends the parent fence until its real child settles.
        // Verify that the original owner row remains unchanged during that interval.
        expect(originalOwner?.kind).toBe("current");
        expect(createManagedHandoffLeaseStore().read(root)).toEqual(originalOwner);
        expect(options?.input).toBe("");
        expect(options?.beforeInput).toBeTypeOf("function");
        expect(options?.env?.OPENCLAW_CONFIG_PATH).toBe(env.OPENCLAW_CONFIG_PATH);
        expect(options?.cwd).not.toBe(root);
      }
      const response = await actualExec.runCommandWithTimeout(argv, options);
      if (argv.includes("--update-executor") && fault === "after") {
        revokeOriginal();
      }
      return response;
    });
    const runCommand: CommandRunner = async (argv, options) => {
      if (argv[0] === "git" || argv[0] === process.execPath) {
        return actualExec.runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "pnpm") {
        if (argv[1] === "build") {
          await writeRuntime(options.cwd!, await git(options.cwd!, "rev-parse", "HEAD"));
        } else if (argv.includes("config") && argv.includes("validate")) {
          const validated = await actualExec.runCommandWithTimeout(
            [
              process.execPath,
              path.join(options.cwd!, "openclaw.mjs"),
              "config",
              "validate",
              "--json",
            ],
            options,
          );
          if (fault === "before") {
            revokeOriginal();
          }
          return validated;
        }
        return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
      }
      throw new Error(`Unexpected candidate command: ${argv.join(" ")}`);
    };
    mocks.runGatewayUpdate.mockImplementation((options: UpdateRunnerOptions) => {
      originalOwner = createManagedHandoffLeaseStore().read(root);
      expect(originalOwner.kind).toBe("current");
      return actualRunner.runGatewayUpdate({ ...options, runCommand });
    });
    const outcome = await runOffer({ root, confirm: vi.fn().mockResolvedValue(true) }).catch(
      (error: unknown) => error,
    );
    const events = (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(await git(root, "rev-parse", "HEAD")).toBe(native ? beforeSha : candidateSha);
    expect(
      events.filter((event) => event.phase === "config"),
      JSON.stringify({
        outcome: outcome instanceof Error ? outcome.stack : outcome,
        result: mocks.completeUpdateCommandRun.mock.calls.map(([result]) => result),
      }),
    ).not.toHaveLength(0);
    for (const observed of events.filter(
      (event) => event.phase === "config" || event.phase === "capability",
    )) {
      expect(observed.root).not.toBe(root);
      expect(observed.config).toBe(env.OPENCLAW_CONFIG_PATH);
    }
    if (fault) {
      expect(outcome).toBeInstanceOf(Error);
      expect(events.map((event) => event.phase)).toEqual(
        fault === "before" ? ["config"] : ["config", "capability"],
      );
      expect(mocks.completeUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.failUpdateCommandRun).not.toHaveBeenCalled();
      expect(mocks.triageCommand).not.toHaveBeenCalled();
    } else if (!native) {
      expect(events.map((event) => event.phase)).toEqual(["config", "prepare"]);
      expect(outcome).toEqual({ updated: true, handled: true });
      expect(mocks.completeUpdateCommandRun).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ok" }),
        originalRun,
      );
    } else if (valid && supported) {
      expect(events.map((event) => event.phase)).toEqual(["config", "capability", "stop"]);
      expect(outcome).toBe(reachedStop);
    } else {
      expect(events.some((event) => event.phase === "stop")).toBe(false);
      expect(events.some((event) => event.phase === "capability")).toBe(valid);
      if (valid) {
        expect(outcome).toMatchObject({
          name: "UpdatePreMutationError",
          reason: "target-native-unsupported",
        });
      }
    }
    expect(mocks.restartUpdatedGateway).not.toHaveBeenCalled();
    if (fault || (native && valid)) {
      expect(mocks.maybeRestartServiceAfterFailedMutableUpdate).not.toHaveBeenCalled();
    }
  },
);
