import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConfigIO } from "../../config/io.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../../infra/update-doctor-result.js";
import { admitFreeBsdUpdateRootOwnership } from "../../infra/update-freebsd-root-ownership.js";
import {
  nativeFreeBsdRoot,
  withFreeBsdRootFixture,
} from "../../infra/update-freebsd-root-ownership.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as childCommands from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";

afterEach(() => vi.restoreAllMocks());

async function databaseFamily(env: NodeJS.ProcessEnv) {
  const file = resolveOpenClawStateSqlitePath(env);
  return await Promise.all(
    ["", "-wal", "-shm", "-journal"].map(
      async (suffix) =>
        await fs.readFile(file + suffix).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return null;
          }
          throw error;
        }),
    ),
  );
}

it.skipIf(!nativeFreeBsdRoot)(
  "the real delegated Doctor refuses foreign config before repair",
  async () => {
    await withFreeBsdRootFixture(async ({ home, env }) => {
      const root = process.cwd();
      const original = JSON.stringify({ plugins: { enabled: false } });
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, original, { mode: 0o600 });
      await expect(admitFreeBsdUpdateRootOwnership({ roots: [root], env })).resolves.toBeDefined();
      const created = createUpdateRun({ trigger: "cli" }, { env });
      closeOpenClawStateDatabaseForTest();
      const before = await databaseFamily(env);
      const control = path.join(home, "executor-control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const worker = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.migratedFinalize);
      const sourceArgs = worker.pathname.endsWith(".ts")
        ? ["--import", path.resolve("scripts/tsx.mjs")]
        : [];
      const resultPath = path.join(home, "doctor-result.json");
      const program = `process.argv[2] = '--doctor'; await import(${JSON.stringify(worker.href)});`;
      await withUpdateCommandExecutor(created.runId, async (executor) => {
        const fence = await executor.enter(root);
        await fs.chown(env.OPENCLAW_CONFIG_PATH!, 65534, 65534);
        const result = await withUpdateCommandExecutorChild(fence, root, (grant, beforeInput) =>
          childCommands.runUtf8CommandWithTimeout(
            [process.execPath, ...sourceArgs, "--input-type=module", "-e", program],
            {
              input: JSON.stringify({
                executor: grant,
                runId: created.runId,
                root,
                configInputHash: createHash("sha256").update(original).digest("hex"),
                repair: true,
              }),
              beforeInput,
              baseEnv: {},
              env: { ...env, [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: resultPath },
              timeoutMs: 30_000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
            },
          ),
        );
        expect(result).toMatchObject({ code: 1, termination: "exit", cleanup: "normal" });
        expect(result.stderr).toContain(
          "FreeBSD foreground updates require real and effective root identity",
        );
        fence.assertCurrent();
      });
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(original);
      expect((await fs.lstat(env.OPENCLAW_CONFIG_PATH!)).uid).toBe(65534);
      expect(await databaseFamily(env)).toEqual(before);
      expect(getUpdateRun(created.runId, { env })).toEqual(created);
      await expect(fs.stat(resultPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
  60_000,
);

it
  .skipIf(!nativeFreeBsdRoot)
  .each([
    "run environment",
    "managed environment",
    "default restart",
    "restart requested",
    "restart disagreement",
    "api origin",
    "campaign origin",
  ])(
  "the real finalizer refuses %s before adopting or replaying history",
  async (selector) => {
    await withFreeBsdRootFixture(async ({ home, env }) => {
      // The native proof installs this candidate beneath a protected root prefix.
      // Use its actual worker, never a synthetic replacement for the finalizer.
      const root = process.cwd();
      const admission = await admitFreeBsdUpdateRootOwnership({ roots: [root], env });
      expect(admission).toBeDefined();
      const created = createUpdateRun(
        {
          trigger:
            selector === "api origin" ? "api" : selector === "campaign origin" ? "campaign" : "cli",
        },
        { env },
      );
      const configSnapshot = await createConfigIO({
        env,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      closeOpenClawStateDatabaseForTest();
      const original = await databaseFamily(env);
      const control = path.join(home, "executor-control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const selected =
        selector === "run environment" ? env.OPENCLAW_STATE_DIR! : path.join(home, "managed-state");
      await fs.mkdir(selected, { recursive: true, mode: 0o700 });
      const managedEnv = { ...env, OPENCLAW_STATE_DIR: selected };
      const nativeCommand = childCommands.runUtf8CommandWithTimeout;
      const receipts: Awaited<ReturnType<typeof nativeCommand>>[] = [];
      vi.spyOn(childCommands, "runUtf8CommandWithTimeout").mockImplementation(
        async (argv, options) => {
          const child = await nativeCommand(argv, options);
          if (argv.at(-1) !== "--check") {
            expect(typeof options).toBe("object");
            if (typeof options !== "object" || typeof options.input !== "string") {
              throw new Error("Candidate continuation input is missing.");
            }
            expect(JSON.parse(options.input).params.opts.run).not.toHaveProperty(
              "freebsdRootAdmission",
            );
            receipts.push(child);
          }
          return child;
        },
      );
      await withUpdateCommandExecutor(created.runId, async (executor) => {
        const executorFence = await executor.enter(root);
        // The parent's last successful admission cannot replace the child's fresh one.
        const foreign = selector === "run environment" || selector === "managed environment";
        if (foreign) {
          await fs.chown(selected, 65534, 65534);
        }
        await expect(
          continueMigratedUpdateInFreshProcess(
            {
              mutationStarted: true,
              result: {
                status: "error",
                reason: "doctor-failed",
                mode: "npm",
                root,
                steps: [],
                durationMs: 0,
              },
              root,
              installKindChanged: false,
              configSnapshot,
              requestedChannel: null,
              storedChannel: "stable",
              channel: "stable",
              downgradeRisk: false,
              shouldRestart: selector === "restart disagreement",
              opts: {
                json: true,
                restart:
                  selector === "default restart" ? undefined : selector === "restart requested",
                run: { runId: created.runId, env, executorFence, freebsdRootAdmission: admission },
              },
              ownedManagedUpdateEnv: selector === "managed environment" ? managedEnv : undefined,
              controlPlaneUpdateSentinelMeta: null,
              preUpdatePluginInstallRecords: {},
              startedAt: Date.now(),
              packageUpdateNodeRunner: process.execPath,
              updateStepTimeoutMs: 30_000,
              rollbackBlockedReason: "state-migrated-no-rollback",
            },
            [{ step: "parent buffered receipt", status: "completed" }],
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        executorFence.assertCurrent();
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ code: 1, termination: "exit", cleanup: "normal" });
      expect(receipts[0]?.stderr).toContain(
        selector === "run environment" || selector === "managed environment"
          ? "FreeBSD foreground updates require real and effective root identity"
          : selector === "restart disagreement"
            ? "FreeBSD finalization requires the existing manual CLI update run"
            : selector === "api origin" || selector === "campaign origin"
              ? "FreeBSD foreground continuation requires the same existing manual CLI update run"
              : "FreeBSD foreground updates require an explicit manual",
      );
      expect(await databaseFamily(env)).toEqual(original);
      expect(getUpdateRun(created.runId, { env })).toEqual(created);
      expect((await fs.lstat(selected)).uid).toBe(
        selector === "run environment" || selector === "managed environment" ? 65534 : 0,
      );
      if (selector === "managed environment") {
        expect(await fs.readdir(selected)).toEqual([]);
      }
    });
  },
  60_000,
);
