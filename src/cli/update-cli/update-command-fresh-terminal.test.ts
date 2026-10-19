import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import * as packageJson from "../../infra/package-json.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "../../infra/package-update-activation-journal.js";
import { packageActivationRuntimeForTest } from "../../infra/package-update-activation-runtime.test-support.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { defaultRuntime } from "../../runtime.js";
import * as shared from "./shared.js";
import * as executorOwner from "./update-command-executor.js";
import { allowPackageRuntime } from "./update-command-fresh-preview.test-support.js";
import { installFreshUpdateFixture } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { UnreportedUpdateAdmissionOutcome, UpdateCommandFailure } from "./update-command-result.js";
import * as commandRun from "./update-command-run.js";
import { updateCommand } from "./update-command.js";

const promptConfirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@clack/prompts", async (original) => ({
  ...(await original<typeof import("@clack/prompts")>()),
  confirm: promptConfirm,
}));

const { fixture, dirs } = installFreshUpdateFixture();
const inheritedRunIds = ["  1c5a25f3-f46a-408b-a87f-a0f0d1f80ee7  ", " \t "] as const;

function expectFreshStatePreserved() {
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  expect(fs.readdirSync(fixture.root)).toEqual(["package.json"]);
}

describe("fresh update terminal reporting", () => {
  it.each(["healthy", "release", "no-enter"] as const)(
    "publishes one settled metadata refusal (%s)",
    async (cleanup) => {
      allowPackageRuntime();
      const detachedRoot = dirs.make("openclaw-detached-refusal-");
      vi.spyOn(os, "tmpdir").mockReturnValue(detachedRoot);
      const doctor = vi.spyOn(packageUpdate, "runPackageUpdateDoctor");
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunIds[0]);
      vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockImplementationOnce(async () => {
        if (cleanup === "release") {
          const db = new DatabaseSync(
            path.join(tempRoot.resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite"),
          );
          try {
            db.exec(
              "CREATE TRIGGER deny_refusal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture refusal release denied'); END",
            );
          } finally {
            db.close();
          }
        }
        return { version: null, nodeEngine: null, error: "fixture registry unavailable" };
      });
      const observations: string[] = [];
      const enter = vi.fn();
      const withExecutor = executorOwner.withUpdateCommandExecutor;
      const execute = vi
        .spyOn(executorOwner, "withUpdateCommandExecutor")
        .mockImplementationOnce((runId, operation, options) =>
          withExecutor(
            runId,
            (executor) => {
              const originalEnter = executor.enter.bind(executor);
              vi.spyOn(executor, "enter").mockImplementation((...args) => {
                enter();
                return originalEnter(...args);
              });
              return operation(executor);
            },
            options,
          ),
        );
      vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
        observations.push(createManagedHandoffLeaseStore().read(fixture.root).kind);
      });
      const failure = await updateCommand({
        yes: true,
        json: true,
        restart: false,
        dryRun: cleanup === "no-enter",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(observations).toEqual([cleanup === "release" ? "current" : "absent"]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          reason:
            cleanup === "release" ? "update-admission-cleanup-failed" : "target-metadata-preflight",
        }),
      );
      expect(execute).toHaveBeenCalledOnce();
      if (cleanup === "no-enter") {
        expect(enter).not.toHaveBeenCalled();
        expect(failure).toBeInstanceOf(UpdateCommandFailure);
        expect(failure).toMatchObject({
          exitCode: 1,
          result: {
            status: "error",
            reason: "target-metadata-preflight",
            failedStep: {
              failureFacts: [expect.objectContaining({ code: "target-registry-metadata" })],
            },
          },
        });
      } else {
        expect(enter).toHaveBeenCalled();
        expect(failure).toMatchObject({ code: 1 });
      }
      const output = vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0];
      assert(isRecord(output) && typeof output.reportPath === "string");
      expect(output.reportPath.startsWith(detachedRoot + path.sep)).toBe(cleanup !== "no-enter");
      expect(fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR!, "update-reports"))).toBe(
        cleanup === "no-enter",
      );
      if (cleanup === "release") {
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          }),
        );
      }
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
      expect(doctor).not.toHaveBeenCalled();
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("registry unavailable"),
      );
      expectFreshStatePreserved();
    },
  );

  it.each(["metadata", "enter", "manager"] as const)(
    "keeps fresh %s refusal reporting detached after a real successor publishes",
    async (refusal) => {
      const swap = await createPackageSwapFixture(dirs.make("openclaw-fresh-successor-"));
      fixture.root = swap.packageRoot;
      const worker = path.join(
        swap.params.stage.packageRoot,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      );
      fs.mkdirSync(path.dirname(worker), { recursive: true });
      fs.writeFileSync(
        worker,
        `import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize).href)});\n`,
      );
      await writePackageDistInventory(swap.params.stage.packageRoot);
      allowPackageRuntime();
      vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
        version: null,
        nodeEngine: null,
        error: "fixture registry unavailable",
      });
      if (refusal === "manager") {
        vi.mocked(shared.resolveGlobalManager).mockRejectedValueOnce(
          new shared.UpdatePreMutationError("unmanaged-package-install", "fixture external owner"),
        );
      }
      const meta = { note: "fresh refusal must not publish this sentinel" };
      const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation()!;
      vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        return prepared ? { ...prepared, controlPlaneUpdateSentinelMeta: meta } : prepared;
      });
      const stateDir = process.env.OPENCLAW_STATE_DIR!;
      for (const relative of ["update-reports/retained.md", "logs/support/retained.json"]) {
        const file = path.join(stateDir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "existing operator artifact\n");
      }
      const readState = () =>
        fs
          .readdirSync(stateDir, { recursive: true })
          .toSorted((left, right) => String(left).localeCompare(String(right)))
          .map((relative) => {
            const file = path.join(stateDir, String(relative));
            return [relative, fs.statSync(file).isFile() ? fs.readFileSync(file) : null];
          });
      const detachedRoot = dirs.make("openclaw-detached-refusal-");
      vi.spyOn(os, "tmpdir").mockReturnValue(detachedRoot);
      const anchor = resolvePackageActivationAnchor(fixture.root);
      const withExecutor = executorOwner.withUpdateCommandExecutor;
      let before: ReturnType<typeof readState> | undefined;
      let journal: Buffer | undefined;
      let acquired = false;
      let injected = false;
      const postReleaseVersionRead = vi.fn(() => {
        throw new Error("released refusal must not reread the replacement package version");
      });
      vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementationOnce(
        async (runId, operation, options) => {
          try {
            return await withExecutor(
              runId,
              async (executor) => {
                const enter = executor.enter.bind(executor);
                vi.spyOn(executor, "enter").mockImplementation(async (...args) => {
                  const fence = await enter(...args);
                  acquired = true;
                  if (refusal === "enter") {
                    // Acquisition can precede a failing identity/admission check.
                    throw new UnreportedUpdateAdmissionOutcome(
                      {
                        root: fixture.root,
                        installKind: "package",
                        reason: "fixture-partial-admission",
                        message: "fixture refused after acquiring the original lease",
                        opts: { json: true },
                        controlPlaneUpdateSentinelMeta: meta,
                      },
                      { exitCode: 0 },
                    );
                  }
                  return fence;
                });
                return operation(executor);
              },
              options,
            );
          } catch (error) {
            expect(acquired).toBe(true);
            expect(error).toBeInstanceOf(UnreportedUpdateAdmissionOutcome);
            expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
            expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
            expect(fs.existsSync(fixture.databasePath)).toBe(false);
            // The actual old executor has settled. Publish a real next journal
            // before the initializer's outer refusal reporter is allowed to run.
            await withExecutor("fresh-refusal-successor", async (executor) => {
              const fence = await executor.enter(fixture.root);
              const published = await swapStagedPackageInstall({
                ...swap.params,
                activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared() {} },
                onTransaction() {},
              });
              expect(published.status, published.step.stderrTail ?? undefined).toBe("committed");
            });
            expect(openPackageActivationJournal(anchor).read().phase).toBe("publication-complete");
            journal = fs.readFileSync(resolvePackageActivationJournalPath(anchor));
            before = readState();
            expect(
              JSON.parse(fs.readFileSync(path.join(fixture.root, "package.json"), "utf8")),
            ).toMatchObject({ version: "2.0.0" });
            vi.spyOn(packageJson, "readPackageVersion").mockImplementation(postReleaseVersionRead);
            injected = true;
            throw error;
          }
        },
      );
      await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toMatchObject({
        code: refusal === "metadata" ? 1 : 0,
      });
      expect(injected).toBe(true);
      expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
      const output = vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0];
      expect(output).toMatchObject({
        status: refusal === "metadata" ? "error" : "skipped",
        reason:
          refusal === "enter"
            ? "fixture-partial-admission"
            : refusal === "manager"
              ? "unmanaged-package-install"
              : "target-metadata-preflight",
      });
      assert(isRecord(output) && typeof output.reportPath === "string");
      expect(output.reportPath.startsWith(detachedRoot + path.sep)).toBe(true);
      expect(fs.existsSync(output.reportPath)).toBe(true);
      expect(output.before).toEqual(refusal === "manager" ? { version: "1.0.0" } : undefined);
      expect(postReleaseVersionRead).not.toHaveBeenCalled();
      expect(readState()).toEqual(before);
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expect(fs.readFileSync(resolvePackageActivationJournalPath(anchor))).toEqual(journal);
      expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
      expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    },
  );
});
