import fs from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as doctorMaintenance from "../../commands/doctor-maintenance.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as packageRoot from "../../infra/openclaw-root.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  DoctorMaintenanceRefusalError,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import * as requesterAuthority from "../../infra/update-requester-authority.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

const mocks = vi.hoisted(() => ({
  entrypoint: vi.fn(),
  runExec: vi.fn(),
  plugins: vi.fn(),
  paths: vi.fn(),
  sizes: vi.fn(),
}));
vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.entrypoint,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: mocks.runExec,
  runUtf8CommandWithTimeout: async ([command, ...args]: string[], options: unknown) => ({
    ...(await mocks.runExec(command, args, options)),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  }),
}));
// Native binding/settlement has real-process coverage. This caller suite keeps
// both process transports inert while exercising its synthetic one-shot fence.
vi.mock("./update-command-doctor-child.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-doctor-child.js")>()),
  inspectUpdateDoctorChildSupport: async () => true,
  withUpdateDoctorChild: async (
    params: Parameters<typeof import("./update-command-doctor-child.js").withUpdateDoctorChild>[0],
    operation: Parameters<
      typeof import("./update-command-doctor-child.js").withUpdateDoctorChild
    >[1],
  ) => {
    params.context.assertRequesterCurrent();
    return await operation(async (_argv, options) => ({
      ...(await mocks.runExec(process.execPath, ["doctor", "--repair"], options)),
      code: 0,
      signal: null,
      killed: false,
      cleanup: "normal",
      termination: "exit",
    }));
  },
}));
vi.mock("../../infra/update-candidate-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-candidate-state.js")>()),
  collectStateDatabasePaths: mocks.paths,
}));
vi.mock("../../infra/update-candidate-state.sizes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-candidate-state.sizes.js")>()),
  readUpdateStateDatabaseSizes: mocks.sizes,
}));
// Package effects and process dispatch are inert. Resume, config preparation,
// plugin lease, retirement ledger, fresh Doctor and readiness remain real owners.
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./update-command-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-runtime.js")>()),
  completeSourceUpdateRuntime: vi.fn(async () => ({ changed: false })),
}));

import { convergeUpdatePlugins } from "./update-command-convergence.js";
import * as executorOwner from "./update-command-executor.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import * as postCore from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};
let state: OpenClawTestState;
let dispatched: string[];

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "doctor-authority-callers",
    env: {
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: undefined,
      OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: undefined,
      // Current parents forward the start time; avoid the legacy parent ps probe.
      OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS: String(Date.now()),
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
    },
  });
  await state.writeConfig({ plugins: { enabled: false } });
  await state.writeJson("package.json", { name: "openclaw", version: VERSION, type: "module" });
  dispatched = [];
  mocks.entrypoint.mockReset().mockResolvedValue(state.path("dist/index.js"));
  mocks.plugins.mockReset().mockResolvedValue(pluginUpdate);
  mocks.paths.mockReset().mockResolvedValue(new Map());
  mocks.sizes.mockReset().mockResolvedValue([]);
  mocks.runExec.mockReset().mockImplementation(async (_command, args: string[]) => {
    dispatched.push(
      args.includes("--repair") ? "repair" : args.includes("--lint") ? "readiness" : "validate",
    );
    return {
      stdout: args.includes("--lint")
        ? JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })
        : "",
      stderr: "",
    };
  });
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

function firstRefusal() {
  const error = new Error("original authority refusal");
  let armed = false;
  let refused = false;
  return {
    error,
    arm: () => {
      armed = true;
    },
    assertCurrent: () => {
      if (armed && !refused) {
        refused = true;
        throw error;
      }
    },
  };
}

describe("unproved Doctor authority callers", () => {
  it.each([false, true])(
    "rechecks legacy requester authority after executor settlement (revoked=%s)",
    async (revoked) => {
      const requester = { channel: "test", senderId: "owner" };
      const run = createUpdateRun({
        trigger: "cli",
        before: { version: "2026.9.2" },
        origin: { requester },
      });
      recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
      recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      const resultPath = state.statePath("post-core-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
      vi.spyOn(packageRoot, "resolveOpenClawPackageRootSync").mockReturnValue(state.root);
      const scratch = state.path("executor");
      await fs.mkdir(scratch, { mode: 0o700 });
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(scratch);
      let current = true;
      let settled = false;
      vi.spyOn(requesterAuthority, "createManagedUpdateRequesterAuthority").mockResolvedValue({
        requester,
        isCurrent: () => current,
      });
      const withExecutor = executorOwner.withUpdateCommandExecutor;
      vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementation(
        async (runId, operation, options) => {
          const result = await withExecutor(runId, operation, options);
          settled = true;
          current = !revoked;
          return result;
        },
      );
      const publication = vi.spyOn(postCore, "writePostCorePluginUpdateResultFile");
      const result = resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true },
        timeoutMs: 5_000,
      });
      if (revoked) {
        await expect(result).rejects.toMatchObject({ code: "requester-revoked" });
        expect(publication).not.toHaveBeenCalled();
        expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
          status: "failed",
          error: "requester-revoked",
        });
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      } else {
        await result;
        expect(publication).toHaveBeenCalledOnce();
        expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({ status: "ok" });
        expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(0);
      }
      expect(settled).toBe(true);
      expect(getUpdateRun(run.runId)?.status).toBe("running");
    },
  );

  it("defers the published parent-owned continuation before preparing an older schema", async () => {
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.5" } });
    expect(adoptUpdateRun(run.runId).origin.driver?.pid).toBe(process.pid);
    recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
    recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
    recordDeferredPluginMigrations({
      pending: [
        {
          pluginId: "pending-fixture",
          reason: "state upgrade deferred",
          command: "openclaw doctor --fix",
          requiresStateMigration: true,
        },
      ],
    });
    const resultPath = state.statePath("parent-owned-result.json");
    await state.writeJson("handoff.json", { completionOwner: "parent" });
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
    const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
    closeOpenClawStateDatabaseForTest();
    const prior = new DatabaseSync(databasePath);
    try {
      removePreparedWorkerOwnershipColumns(prior);
      prior.exec(
        "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
      );
    } finally {
      prior.close();
    }
    const inspect = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return {
          version: db.prepare("PRAGMA user_version").get(),
          schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
          pending: db
            .prepare(
              "SELECT * FROM migration_runs WHERE id LIKE 'deferred-plugin-migration:%' ORDER BY id",
            )
            .all(),
          steps: JSON.parse(
            String(
              db.prepare("SELECT steps_json FROM update_runs WHERE run_id=?").get(run.runId)
                ?.steps_json,
            ),
          ),
        };
      } finally {
        db.close();
      }
    };
    const before = inspect();
    const holder = acquireGatewayStateOwner({
      databasePath,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
        role: "gateway",
      },
    });
    expect(holder).not.toBeNull();
    const maintenance = vi.spyOn(doctorMaintenance, "beginDoctorMaintenance");
    try {
      const work = resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true },
        timeoutMs: 5_000,
      }).catch((error: unknown) => error);
      expect(await work).toBeUndefined();
      expect(maintenance).toHaveBeenCalledWith(expect.objectContaining({ root: null }));
      expect(maintenance.mock.calls[0]?.[0].assertCurrent).toBeUndefined();
      expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
        status: "warning",
        changed: false,
        warnings: [expect.objectContaining({ reason: "doctor-advisory" })],
      });
      const after = inspect();
      expect(after.version).toEqual(before.version);
      expect(after.schema).toEqual(before.schema);
      expect(after.pending).toEqual(before.pending);
      expect(after.steps).toContainEqual(
        expect.objectContaining({ step: "warning:finalize:plugins:0", status: "completed" }),
      );
      expect(mocks.plugins).not.toHaveBeenCalled();
      expect(dispatched).toEqual([]);
      expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      holder?.release();
    }
  });

  it.each([
    "parent-admission",
    "fresh-doctor",
    "post-plugin-doctor",
    "incomplete-migration",
  ] as const)(
    "settles the published parent's %s maintenance outcome before publication",
    async (boundary) => {
      const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.5" } });
      expect(adoptUpdateRun(run.runId).origin.driver?.pid).toBe(process.pid);
      recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
      recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      const resultPath = state.statePath("maintenance-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
      const unsafe = boundary === "incomplete-migration";
      const refusal = new DoctorMaintenanceRefusalError(
        "Doctor maintenance remains pending; stop other OpenClaw processes and run openclaw doctor --fix.",
        unsafe
          ? { kind: "data-at-risk", reason: "incomplete-migration" }
          : { kind: "deferred", reason: "coordinator-contention" },
      );
      const maintenance = {
        signal: new AbortController().signal,
        run: <T>(operation: () => T) => operation(),
        releaseState: vi.fn(async () => {}),
        finish: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
      };
      vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockImplementation(async () => {
        if (boundary === "parent-admission" || unsafe) {
          throw refusal;
        }
        return maintenance;
      });
      if (boundary === "post-plugin-doctor") {
        mocks.plugins.mockResolvedValue({ ...pluginUpdate, changed: true });
      }
      const dispatch = mocks.runExec.getMockImplementation()!;
      let doctorPass = 0;
      mocks.runExec.mockImplementation(async (command, args, options) => {
        const result = await dispatch(command, args, options);
        if (
          args.includes("--repair") &&
          ++doctorPass === (boundary === "post-plugin-doctor" ? 2 : 1)
        ) {
          await writeUpdatePostInstallDoctorResult({
            resultPath: options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
            result: {
              status: "ok",
              warnings: [refusal.message],
              maintenanceRefusal: refusal.refusal,
            },
          });
        }
        return result;
      });
      const pending = resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true },
        timeoutMs: 5_000,
      });
      if (unsafe) {
        await expect(pending).rejects.toBe(refusal);
        expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
          status: "failed",
        });
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      } else {
        await pending;
        expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
          status: "warning",
          changed: boundary === "post-plugin-doctor",
          warnings: [{ reason: "doctor-advisory", message: refusal.message }],
        });
        expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(defaultRuntime.error).not.toHaveBeenCalledWith(
          expect.stringContaining("Post-core update evidence could not be saved"),
        );
        expect(getUpdateRun(run.runId)?.steps).toContainEqual(
          expect.objectContaining({
            step: "warning:finalize:plugins:0",
            status: "completed",
            detail: refusal.message,
          }),
        );
      }
      expect(dispatched).toEqual(
        boundary === "fresh-doctor"
          ? ["repair"]
          : boundary === "post-plugin-doctor"
            ? ["repair", "repair"]
            : [],
      );
      expect(mocks.plugins).toHaveBeenCalledTimes(boundary === "post-plugin-doctor" ? 1 : 0);
      expect(maintenance.finish).toHaveBeenCalledTimes(
        boundary === "fresh-doctor" || boundary === "post-plugin-doctor" ? 1 : 0,
      );
    },
  );

  it.each(["2026.9.3", "2026.9.4"])(
    "keeps the shipped %s child-owned completion route outside the 9.2 bridge",
    async (version) => {
      const run = createUpdateRun({ trigger: "cli", before: { version } });
      recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
      recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      await resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true },
        timeoutMs: 5_000,
      });
      expect(dispatched).toEqual(["repair", "validate", "readiness"]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: run.runId,
          steps: [expect.objectContaining({ doctorLintFindings: [] })],
        }),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(0);
    },
  );

  it.each([false, true])(
    "publishes settled phase evidence only for older parents (parent owns completion=%s)",
    async (parentOwnsCompletion) => {
      const run = createUpdateRun({ trigger: "cli" });
      adoptUpdateRun(run.runId);
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
      });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      const resultPath = state.statePath("post-core-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", resultPath);
      if (parentOwnsCompletion) {
        await state.writeJson("handoff.json", { completionOwner: "parent" });
      }
      await fs.mkdir(state.path("phase-artifacts"));
      vi.spyOn(os, "tmpdir").mockReturnValue(state.path("phase-artifacts"));
      let restored = false;
      const maintenance = vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue({
        signal: new AbortController().signal,
        run: (operation) => operation(),
        releaseState: async () => {},
        release: async () => {},
        finish: async () => {
          await Promise.resolve();
          restored = true;
        },
      });
      let phasePath: string | undefined;
      vi.mocked(defaultRuntime.error).mockImplementation((line) => {
        const prefix = "Post-plugin Doctor report (update completion pending): ";
        if (typeof line === "string" && line.startsWith(prefix)) {
          expect(restored).toBe(true);
          phasePath = line.slice(prefix.length);
        }
      });
      const writeResult = postCore.writePostCorePluginUpdateResultFile;
      const publication = vi
        .spyOn(postCore, "writePostCorePluginUpdateResultFile")
        .mockImplementation(async (...args) => {
          const lintStep = expect.objectContaining({
            step: "finalize:doctor-lint:post-plugin-doctor-lint",
          });
          if (parentOwnsCompletion) {
            expect(getUpdateRun(run.runId)?.steps).not.toContainEqual(lintStep);
            expect(dispatched).toEqual([]);
            expect(args[1]?.doctorLint).toBeUndefined();
          } else {
            expect(getUpdateRun(run.runId)?.steps).toContainEqual(lintStep);
            // Legacy resume prepares migrations before producing plugins, then
            // completion handles the recorded deferred retirement.
            expect(dispatched).toEqual(["repair", "repair", "validate", "readiness"]);
          }
          expect(getUpdateRun(run.runId)?.status).toBe("running");
          const canonicalPath = state.statePath("update-reports", `${run.runId}.md`);
          await expect(fs.stat(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
          if (parentOwnsCompletion) {
            expect(phasePath).toBeUndefined();
            expect(maintenance).toHaveBeenCalledWith(expect.objectContaining({ root: null }));
          } else {
            expect(phasePath).toBeDefined();
            expect(phasePath).not.toBe(canonicalPath);
            const report = await fs.readFile(phasePath!, "utf8");
            expect(report).toContain("update completion is pending with the parent updater");
            expect(report).toContain("Complete Doctor lint findings (0)");
          }
          await writeResult(...args);
        });

      await resumePostCoreUpdate({
        root: state.root,
        channel: "stable",
        opts: { json: true, yes: true },
        timeoutMs: 5_000,
      });

      expect(publication).toHaveBeenCalledOnce();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(defaultRuntime.log).not.toHaveBeenCalled();
    },
  );

  it.each(["live", "paths", "sizes"] as const)(
    "fences default-budget %s await before the next child",
    async (boundary) => {
      const authority = firstRefusal();
      if (boundary !== "live") {
        const mock = boundary === "paths" ? mocks.paths : mocks.sizes;
        mock.mockImplementationOnce(async () => {
          await Promise.resolve();
          authority.arm();
          return boundary === "paths" ? new Map() : [];
        });
      }
      const result = completePostCorePluginUpdate({
        root: state.root,
        pluginUpdate,
        freshDoctorRequired: true,
        yes: true,
        json: true,
        assertCurrent: authority.assertCurrent,
      });
      if (boundary === "live") {
        expect((await result).pluginUpdate.status).toBe("ok");
        expect(dispatched).toEqual(["repair", "validate", "readiness"]);
        expect(mocks.runExec.mock.calls.map((call) => call[2].timeoutMs)).toEqual([
          undefined,
          300_000,
          300_000,
        ]);
      } else {
        await expect(result).rejects.toBe(authority.error);
        expect(dispatched).toEqual(["repair"]);
      }
    },
  );

  it.each(["live", "first-refusal"] as const)(
    "forwards original authority through resumed production and parent completion: %s",
    async (boundary) => {
      const authority = firstRefusal();
      const run = createUpdateRun({ trigger: "cli", before: { version: VERSION } });
      recordUpdateRunStep(run.runId, {
        step: "finalize:doctor:model-retirement",
        status: "skipped",
      });
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
      // The modern child publishes plugin work without starting Doctor. Exercise
      // deferred retirement through the real parent that consumes that result.
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_RESULT_PATH", state.statePath("post-core-result.json"));
      await state.writeJson("handoff.json", { completionOwner: "parent" });
      if (boundary === "first-refusal") {
        mocks.entrypoint.mockImplementationOnce(async () => {
          await Promise.resolve();
          authority.arm();
          return state.path("dist/index.js");
        });
      }
      const before = await readConfigFileSnapshot({ observe: false });
      const publication = vi.spyOn(postCore, "writePostCorePluginUpdateResultFile");
      const handoff = vi
        .spyOn(postCore, "continuePostCoreUpdateInFreshProcess")
        .mockImplementationOnce(async (params) => {
          await resumePostCoreUpdate(params);
          expect(dispatched).toEqual([]);
          expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(0);
          const published = publication.mock.lastCall?.[1];
          expect(published).toBeDefined();
          expect(published?.doctorLint).toBeUndefined();
          return { resumed: true, pluginUpdate: published };
        });
      const result = convergeUpdatePlugins({
        result: { status: "ok", mode: "npm", root: state.root, steps: [], durationMs: 0 },
        root: state.root,
        installKindChanged: false,
        configSnapshot: before,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: false,
        opts: {
          json: true,
          yes: true,
          run: { runId: run.runId, env: process.env, executorFence: authority },
        },
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 5_000,
      });
      if (boundary === "live") {
        const completed = await result;
        expect(dispatched).toEqual(["repair", "validate", "readiness"]);
        expect(completed.resultWithPostUpdate.postUpdate?.plugins?.doctorLint).toBeDefined();
      } else {
        await expect(result).rejects.toBe(authority.error);
        expect(dispatched).toEqual([]);
      }
      expect(handoff).toHaveBeenCalledOnce();
      expect(publication).toHaveBeenCalledOnce();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect((await readConfigFileSnapshot({ observe: false })).raw).toBe(before.raw);
    },
  );
});
