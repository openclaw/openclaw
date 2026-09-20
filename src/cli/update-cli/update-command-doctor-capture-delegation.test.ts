import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as processRunner from "../../process/exec.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";

const { executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

it.each(
  (["package", "git"] as const).flatMap((kind) =>
    (["healthy", "requester-revoked", "run-replaced"] as const).map((fault) => ({ kind, fault })),
  ),
)(
  "delegates $kind Doctor without reusing its suspended parent ($fault)",
  async ({ kind, fault }) => {
    await withTestDir({ prefix: "update-doctor-delegation-" }, async (dir) => {
      const root = await fs.realpath(dir);
      const control = path.join(root, "leases");
      await fs.mkdir(control);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const env = {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", type: "module", version: "2026.9.4" }),
      );
      await fs.writeFile(path.join(root, "dist", "index.js"), "");
      const owner = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
      const marker = path.join(root, "doctor-ran");
      const updateRecoveryBackup = {
        directory: path.join(root, "recovery"),
        manifestPath: path.join(root, "recovery", "manifest.json"),
        manifestSha256: "a".repeat(64),
      };
      const received = path.join(root, "doctor-input-received");
      await fs.writeFile(
        path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
        `
      import fs from "node:fs";
      ${owner.pathname.endsWith(".ts") ? `await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/tsx.mjs")).href)});` : ""}
      const {withDelegatedUpdateCommandExecutor}=await import(${JSON.stringify(owner.href)});
      const raw=fs.readFileSync(0,"utf8");
      if(raw) fs.writeFileSync(${JSON.stringify(received)},"received");
      const input=JSON.parse(raw);
      await withDelegatedUpdateCommandExecutor(input.executor,input.runId,input.root,async fence=>{
        fence.assertCurrent();
        fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({owner:"owned",backup:input.updateRecoveryBackup}));
      });
    `,
      );
      let requesterCurrent = true;
      let reachedSpawn = false;
      const runChild = processRunner.runUtf8CommandWithTimeout;
      vi.spyOn(processRunner, "runUtf8CommandWithTimeout").mockImplementation((argv, options) => {
        const commandOptions = typeof options === "number" ? { timeoutMs: options } : options;
        return runChild(argv, {
          ...commandOptions,
          beforeInput: (pid, spawnedArgv) => {
            reachedSpawn = true;
            if (fault === "requester-revoked") {
              requesterCurrent = false;
            }
            if (fault === "run-replaced") {
              params.opts.run = { runId: "replacement-run", env };
            }
            commandOptions.beforeInput?.(pid, spawnedArgv);
          },
        });
      });
      const params = executionParams(kind);
      params.root = root;
      params.opts.run = {
        runId,
        env,
        requesterAuthority: { requester: {}, isCurrent: () => requesterCurrent },
      };
      mocks.nativeSupport.mockResolvedValue(true);
      mocks.validateCanary.mockResolvedValue({
        status: "ok",
        phase: "readiness",
        steps: [],
        durationMs: 1,
        logTail: [],
        doctorConfigWrites: true,
      });
      const runUpdate = async (
        options: Pick<Parameters<typeof runPackageUpdateDoctor>[0], "getDoctorContext"> & {
          validateCandidate?: (root: string) => Promise<unknown>;
        },
      ) => {
        await options.validateCandidate?.(root);
        const step = await runPackageUpdateDoctor({
          root,
          timeoutMs: 20_000,
          progress: {},
          managedServiceEnv: env,
          updateRecoveryBackup,
          getDoctorContext: options.getDoctorContext,
        });
        return {
          ...successfulUpdate,
          root,
          mode: kind === "git" ? ("git" as const) : ("npm" as const),
          steps: step ? [step] : [],
          status: step?.exitCode === 0 ? ("ok" as const) : ("error" as const),
        };
      };
      mocks.runPackageUpdate.mockImplementation(runUpdate);
      mocks.runGitUpdate.mockImplementation(runUpdate);
      const update = withUpdateCommandExecutor(runId, async (executor) => {
        params.opts.run!.executorFence = await executor.enter(root);
        return executeMutableUpdate(params);
      });
      if (fault !== "healthy") {
        await expect(update).rejects.toThrow("requester-revoked");
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(received)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect((await update)?.result).toMatchObject({
          status: "ok",
          steps: [{ name: "openclaw doctor", exitCode: 0 }],
        });
        expect(JSON.parse(await fs.readFile(marker, "utf8"))).toEqual({
          owner: "owned",
          backup: updateRecoveryBackup,
        });
      }
      expect(reachedSpawn).toBe(true);
      expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    });
  },
);
