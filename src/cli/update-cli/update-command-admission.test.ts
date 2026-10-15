import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { prepareGitMutation } from "../../infra/update-runner-git-target.js";
import * as databaseBackup from "../../snapshot/database-backup.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

const { bindExecutionGuards, executionParams, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

describe("update target admission", () => {
  it("admits a compatible Git target through inspection and activation without copying stores", async () =>
    withTestDir({ prefix: "engine-compatible-activation-" }, async (dir) => {
      const control = path.join(dir, "leases");
      await fs.mkdir(control);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const env = { OPENCLAW_STATE_DIR: dir };
      const { runId } = createUpdateRun(
        { trigger: "cli", target: { kind: "git", channel: "dev" } },
        { env },
      );
      const context = { ...schemaContext("invoker"), env, readEnv: env };
      mocks.captureSchemaContext.mockResolvedValue(context);
      mocks.captureManagedPreflight.mockResolvedValue(context);
      mocks.maybeStopService.mockResolvedValue({
        inspected: true,
        running: false,
        stopped: false,
        offline: true,
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned",
          root: dir,
          fingerprint: "service-fingerprint",
          refreshDefinition: false,
        },
      });
      const engineReads = vi.spyOn(databaseBackup, "readBackupEngine");
      const events: string[] = [];
      mocks.runGitUpdate.mockImplementation(
        async (
          options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
        ) => {
          if (!options.inspectGitTarget || !options.beforeGitMutation) {
            throw new Error("Missing actual Git admission callbacks");
          }
          const target = { databaseEngines: ["sqlite", "postgres"] };
          await options.inspectGitTarget(target);
          events.push("inspected");
          await options.beforeGitMutation(target);
          events.push("activated");
          return { ...successfulUpdate, mode: "git" };
        },
      );
      const result = await withUpdateCommandExecutor(runId, async (executor) => {
        mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
          admitExecutor(await executor.enter(dir));
        });
        return executeMutableUpdate(
          await bindExecutionGuards({
            ...executionParams("git"),
            root: dir,
            shouldRestart: false,
            opts: { json: true, restart: false, run: { runId, env } },
          }),
        );
      });
      expect(result?.result.status).toBe("ok");
      expect(result?.mutationStarted).toBe(true);
      expect(events).toEqual(["inspected", "activated"]);
      expect(engineReads).not.toHaveBeenCalled();
    }));

  it.each(["package", "staged", "git"] as const)(
    "refuses an unsupported native receiver before activation: %s",
    async (route) =>
      withTestDir({ prefix: "native-before-activation-" }, async (dir) => {
        const control = path.join(dir, "leases");
        await fs.mkdir(control);
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const env = { OPENCLAW_STATE_DIR: dir };
        const runId = createUpdateRun(
          {
            trigger: "cli",
            target: route === "git" ? { kind: "git", channel: "dev", tag: "latest" } : {},
          },
          { env },
        ).runId;
        const params = executionParams(route === "git" ? "git" : "package");
        params.root = dir;
        params.updateStepTimeoutMs = 600_000;
        params.opts.run = { runId, env };
        mocks.captureSchemaContext.mockResolvedValue({
          ...schemaContext("invoker"),
          env,
          readEnv: env,
        });
        mocks.captureManagedPreflight.mockResolvedValue(undefined);
        const engineReads = vi.spyOn(databaseBackup, "readBackupEngine");
        const databaseEngines = ["sqlite", "postgres"];
        await fs.writeFile(
          path.join(dir, "package.json"),
          JSON.stringify({ openclaw: { databaseEngines } }),
        );
        if (route === "staged") {
          params.packageInstallSpec = path.join(dir, "candidate.tgz");
        }
        const events: string[] = [];
        mocks.nativeSupport.mockImplementation(async ({ executor }) => {
          executor.assertCurrent();
          events.push("native-admission");
          return false;
        });
        const candidate = async ({
          validateCandidate,
        }: {
          validateCandidate: (root: string) => Promise<unknown>;
        }) => {
          await validateCandidate(dir);
          // Models the package/Git publisher which follows successful validation.
          events.push("publish");
          return successfulUpdate;
        };
        mocks.runPackageUpdate.mockImplementation(candidate);
        mocks.runGitUpdate.mockImplementation(
          async (
            options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
          ) => {
            if (!options.inspectGitTarget || !options.validateCandidate) {
              throw new Error("Missing actual Git admission callbacks");
            }
            await prepareGitMutation({
              root: dir,
              revision: "1111111111111111111111111111111111111111",
              timeoutMs: params.updateStepTimeoutMs,
              runCommand: async () => ({
                code: 0,
                stderr: "",
                stdout: JSON.stringify({
                  version: "2026.9.4",
                  openclaw: { schemaVersions: { state: 15, agent: 19 }, databaseEngines },
                }),
              }),
              beforeGitMutation: options.inspectGitTarget,
            });
            expect(getUpdateRun(runId, { env })?.target).toMatchObject({
              version: "2026.9.4",
              sha: "1111111111111111111111111111111111111111",
            });
            await options.inspectGitTarget({
              sha: "2222222222222222222222222222222222222222",
              schemaVersions: { state: 15, agent: 19 },
              databaseEngines,
            });
            return candidate({ validateCandidate: options.validateCandidate });
          },
        );
        const result = await withUpdateCommandExecutor(runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
            admitExecutor(await executor.enter(dir));
          });
          return executeMutableUpdate(await bindExecutionGuards(params));
        });
        expect(result?.result).toMatchObject({
          status: "error",
          reason: "target-native-unsupported",
        });
        expect(events).toEqual(["native-admission"]);
        expect(mocks.nativeSupport.mock.calls[0]?.[0]).toMatchObject({
          timeoutMs: params.updateStepTimeoutMs,
        });
        expect(mocks.serviceStopped).toBe(false);
        expect(mocks.validateCanary).not.toHaveBeenCalled();
        // Known target support must not copy live stores merely to rediscover their engines.
        expect(engineReads).not.toHaveBeenCalled();
        if (route === "git") {
          expect(getUpdateRun(runId, { env })?.target).toEqual({
            kind: "git",
            channel: "dev",
            tag: "latest",
            sha: "2222222222222222222222222222222222222222",
          });
        }
      }),
  );
});
