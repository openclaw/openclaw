import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as doctorHealth from "../flows/doctor-health.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  createUpdateRecoveryBackup,
  inspectUpdateRecoveryBackups,
  retireUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../infra/update-recovery-backup.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { doctorCommand } from "./doctor.js";

const mocks = vi.hoisted(() => ({
  coordinator: vi.fn<() => string>(),
  afterClose: vi.fn<() => Promise<void>>(),
}));
vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: mocks.coordinator,
}));
vi.mock("../infra/update-run-driver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-driver.js")>()),
  inspectUpdateRunDriver: () => "dead",
}));
vi.mock("../flows/doctor-health.js", () => ({ runDoctorHealthFlow: async () => {} }));
vi.mock("./doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => ({
    assertCurrent() {},
    closeStores: async () => {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      await mocks.afterClose();
    },
    release: async () => {},
  }),
}));

const authority = { assertOwned() {} };

async function prepareState(state: OpenClawTestState) {
  const coordinator = state.path("coordinator");
  await fs.mkdir(coordinator, { mode: 0o700 });
  mocks.coordinator.mockReturnValue(coordinator);
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  const scope = { agentId: "main", sessionKey: "agent:main:retained", env: state.env };
  await upsertSessionEntryCore(scope, { sessionId: "before-update", updatedAt: 1 });
  await fs.mkdir(state.path("install"), { mode: 0o700 });
  return scope;
}

function output(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code) => {
      throw new ExitError(code);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.afterClose.mockReset();
});

describe("Doctor recovery ledger reconciliation", () => {
  it.each([
    { extra: undefined, marked: false },
    { extra: "requested", marked: false },
    { extra: "openclaw doctor", marked: true },
  ] as const)(
    "binds legacy Doctor capture to its active step and parent (extra=$extra, marked=$marked)",
    async ({ extra, marked }) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const original = await prepareState(state);
        const current = createUpdateRun({ trigger: "cli" }, { env: state.env });
        recordUpdateRunStep(
          current.runId,
          {
            step: "openclaw doctor",
            status: "in_progress",
            startedAtMs: Date.now(),
          },
          { env: state.env },
        );
        const other = extra ? createUpdateRun({ trigger: "cli" }, { env: state.env }) : undefined;
        if (other && extra === "openclaw doctor") {
          recordUpdateRunStep(
            other.runId,
            {
              step: extra,
              status: "in_progress",
              startedAtMs: Date.now(),
            },
            { env: state.env },
          );
        }
        const unrelated = other && getUpdateRun(other.runId, { env: state.env });
        expect(getUpdateRun(current.runId, { env: state.env })?.origin).toEqual({});
        const migrated = {
          agentId: "main",
          sessionKey: "agent:main:legacy-migration",
          env: state.env,
        };
        vi.spyOn(doctorHealth, "runDoctorHealthFlow").mockImplementationOnce(async () => {
          await upsertSessionEntryCore(migrated, { sessionId: "migration-created", updatedAt: 2 });
          throw new Error("synthetic legacy Doctor migration failure");
        });
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            [UPDATE_RUN_ID_ENV]: marked ? current.runId : undefined,
          },
          async () => {
            await expect(
              doctorCommand(output(), { repair: true, nonInteractive: true }),
            ).rejects.toThrow("synthetic legacy Doctor migration failure");
          },
        );
        const captures = await inspectUpdateRecoveryBackups();
        expect(captures).toHaveLength(1);
        const capture = captures[0];
        expect(capture?.runId).toBe(current.runId);
        if (!capture) {
          throw new Error("Expected the legacy Doctor recovery capture");
        }
        const manifest = await verifyUpdateRecoveryBackup(capture.ref);
        expect(manifest.drivers).toContainEqual({
          host: hostname(),
          pid: process.ppid,
          startIdentity: expect.stringMatching(/^\d+$/),
        });
        expect(loadSessionEntryReadOnly(migrated)).toBeUndefined();
        expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
        expect(listUpdateRuns({}, { env: state.env })).toHaveLength(other ? 2 : 1);
        if (other) {
          expect(getUpdateRun(other.runId, { env: state.env })).toEqual(unrelated);
        }
      });
    },
  );

  it.each(["no Doctor", "completed Doctor", "two Doctors", "wrong marker"] as const)(
    "refuses uncorrelated legacy capture before migration: %s",
    async (scenario) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const original = await prepareState(state);
        const current = createUpdateRun({ trigger: "cli" }, { env: state.env });
        if (scenario !== "no Doctor") {
          recordUpdateRunStep(
            current.runId,
            {
              step: "openclaw doctor",
              status: scenario === "completed Doctor" ? "completed" : "in_progress",
              startedAtMs: Date.now(),
            },
            { env: state.env },
          );
        }
        if (scenario === "two Doctors") {
          const other = createUpdateRun({ trigger: "cli" }, { env: state.env });
          recordUpdateRunStep(
            other.runId,
            {
              step: "openclaw doctor",
              status: "in_progress",
              startedAtMs: Date.now(),
            },
            { env: state.env },
          );
        }
        const before = listUpdateRuns({}, { env: state.env });
        const config = await fs.readFile(state.configPath, "utf8");
        const flow = vi.spyOn(doctorHealth, "runDoctorHealthFlow");
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            [UPDATE_RUN_ID_ENV]: scenario === "wrong marker" ? "missing-update-run" : undefined,
          },
          async () => {
            await expect(
              doctorCommand(output(), { repair: true, nonInteractive: true }),
            ).rejects.toThrow(/identify.*openclaw update status --json/s);
          },
        );
        expect(flow).not.toHaveBeenCalled();
        expect(await inspectUpdateRecoveryBackups()).toEqual([]);
        expect(listUpdateRuns({}, { env: state.env })).toEqual(before);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
        expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
      });
    },
  );

  it("reports retained captures during plain Doctor without restoring or publishing outcomes", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-failure", updatedAt: 2 });
      const savedRun = getUpdateRun(run.runId, { env: state.env });
      const config = await fs.readFile(state.configPath, "utf8");
      const manifest = await fs.readFile(ref.manifestPath, "utf8");
      const runtime = output();

      await doctorCommand(runtime, { nonInteractive: true });

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(ref.manifestPath));
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw update status --json"),
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("npx openclaw@latest doctor --fix"),
      );
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-failure");
      expect(getUpdateRun(run.runId, { env: state.env })).toEqual(savedRun);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
      expect(await fs.readFile(ref.manifestPath, "utf8")).toBe(manifest);
      await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
    });
  });
  it("resumes interrupted terminal capture retirement through Doctor without restoring newer sessions", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
      await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-terminal-update", updatedAt: 2 });
      const rmdir = fs.rmdir;
      const interruption = vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
        if (String(target) === ref.directory) {
          throw new Error("synthetic retirement directory removal failure");
        }
        await rmdir(target);
      });
      try {
        await expect(retireUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
          "synthetic retirement directory removal failure",
        );
      } finally {
        interruption.mockRestore();
      }
      expect(await fs.readdir(ref.directory)).toEqual([]);
      const retainedRun = getUpdateRun(run.runId, { env: state.env });
      expect(retainedRun?.origin.updateRecoveryCapture?.retirement).toMatchObject({
        directory: ref.directory,
        outcome: "committed",
      });
      const config = await fs.readFile(state.configPath, "utf8");
      const runtime = output();

      await doctorCommand(runtime, { repair: true, nonInteractive: true });

      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-terminal-update");
      expect(getUpdateRun(run.runId, { env: state.env })).toMatchObject({
        status: "succeeded",
        reason: retainedRun?.reason,
        finishedAtMs: retainedRun?.finishedAtMs,
        origin: { updateRecoveryCapture: retainedRun?.origin.updateRecoveryCapture },
      });
      expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(path.dirname(ref.directory))).rejects.toMatchObject({ code: "ENOENT" });
      expect(runtime.log).toHaveBeenCalledWith(
        `Resolved update capture retired: ${ref.manifestPath}`,
      );
    });
  });

  it.each(["legacy updater", "manual recovery"] as const)(
    "keeps restored state terminal when outcome publication fails during %s",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const original = await prepareState(state);
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        recordUpdateRunStep(
          run.runId,
          {
            step: "openclaw doctor",
            status: "in_progress",
            startedAtMs: Date.now(),
          },
          { env: state.env },
        );
        const migrated = {
          agentId: "main",
          sessionKey: "agent:main:failed-migration",
          env: state.env,
        };
        if (mode === "manual recovery") {
          await createUpdateRecoveryBackup({
            ...authority,
            runId: run.runId,
            installRoot: state.path("install"),
          });
          await upsertSessionEntryCore(migrated, { sessionId: "migration-created", updatedAt: 2 });
          finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
        }
        const failure = new Error("synthetic Doctor failure after migration");
        vi.spyOn(doctorHealth, "runDoctorHealthFlow").mockImplementationOnce(async () => {
          if (mode === "legacy updater") {
            await upsertSessionEntryCore(migrated, {
              sessionId: "migration-created",
              updatedAt: 2,
            });
          }
          throw failure;
        });
        const link = fs.link;
        let publicationFailed = false;
        const publication = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
          if (path.basename(String(to)) === "outcome.json") {
            publicationFailed = true;
            throw new Error("synthetic restored outcome publication failure");
          }
          await link(from, to);
        });
        try {
          await withEnvAsync(
            {
              OPENCLAW_UPDATE_IN_PROGRESS: mode === "legacy updater" ? "1" : undefined,
              [UPDATE_RUN_ID_ENV]: mode === "legacy updater" ? run.runId : undefined,
            },
            async () => {
              await expect(
                doctorCommand(output(), { repair: true, nonInteractive: true }),
              ).rejects.toBe(failure);
            },
          );
        } finally {
          publication.mockRestore();
        }
        expect(publicationFailed).toBe(true);
        expect(loadSessionEntryReadOnly(migrated)).toBeUndefined();
        expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
        const restored = getUpdateRun(run.runId, { env: state.env });
        // The older updater reports its failed attempt after its Doctor exits.
        finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
        if (mode === "legacy updater") {
          // Tagged 9.2 parses origin through a schema without recovery receipts on its next write.
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("UPDATE update_runs SET origin_json = '{}' WHERE run_id = ?")
            .run(run.runId);
        }
        const captures = await inspectUpdateRecoveryBackups();
        expect(captures).toHaveLength(1);
        const capture = captures[0];
        if (!capture) {
          throw new Error("Expected the retained restored capture");
        }
        await expect(
          fs.lstat(path.join(capture.ref.directory, "outcome.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const newer = { agentId: "main", sessionKey: "agent:main:after-restore", env: state.env };
        await upsertSessionEntryCore(newer, { sessionId: "after-restored-session", updatedAt: 3 });
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawStateDatabaseForTest();
        const runtime = output();
        await doctorCommand(runtime, { repair: true, nonInteractive: true });
        expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-restored-session");
        expect(restored?.origin.updateRecoveryCapture).toMatchObject({
          manifestSha256: capture.ref.manifestSha256,
          restored: true,
        });
        if (mode === "legacy updater") {
          expect(restored?.steps).toContainEqual(
            expect.objectContaining({ step: "state rollback", status: "completed" }),
          );
        }
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("stale"));
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining(capture.ref.manifestPath),
        );
        await expect(fs.lstat(capture.ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("preserves new sessions after successful update outcome publication fails", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
      const link = fs.link;
      const publication = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
        if (to === path.join(ref.directory, "outcome.json")) {
          throw new Error("synthetic outcome publication failure");
        }
        await link(from, to);
      });
      try {
        await expect(
          writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority),
        ).rejects.toThrow("synthetic outcome publication failure");
      } finally {
        publication.mockRestore();
      }
      await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-update", updatedAt: 2 });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      const runtime = output();
      await doctorCommand(runtime, { repair: true, nonInteractive: true });
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-update");
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(ref.manifestPath));
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("stale"));
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Resolved update capture retired"),
      );
    });
  });

  it("retains and reports unresolved recovery when three later protected updates are refused", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      await writeUpdateRecoveryBackupOutcome(
        ref,
        { status: "restore-failed", error: "synthetic restore failure" },
        authority,
      );
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      const configBefore = await fs.readFile(state.configPath, "utf8");
      for (let index = 0; index < 3; index++) {
        const later = createUpdateRun({ trigger: "cli" }, { env: state.env });
        await expect(
          createUpdateRecoveryBackup({
            ...authority,
            runId: later.runId,
            installRoot: state.path("install"),
          }),
        ).rejects.toThrow(
          /another protected mutation is refused.*openclaw update status --json.*npx openclaw@latest doctor --fix/s,
        );
        finishUpdateRun(later.runId, { status: "failed" }, { env: state.env });
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
      }
      const retained = await inspectUpdateRecoveryBackups();
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({
        ref,
        status: "unresolved",
        message: expect.stringContaining(ref.manifestPath),
        nextAction: "npx openclaw@latest doctor --fix",
      });
    });
  });

  it.each([
    { name: "terminal rollback", status: "rolled-back", step: undefined },
    { name: "state restored before later failure", status: "failed", step: "state rollback" },
    {
      name: "generation restored before later failure",
      status: "failed",
      step: "previous generation restoration",
    },
  ] as const)("refuses stale restoration after $name", async ({ status, step }) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      if (step) {
        recordUpdateRunStep(
          run.runId,
          { step, status: "completed", endedAtMs: Date.now() },
          { env: state.env },
        );
      }
      finishUpdateRun(run.runId, { status }, { env: state.env });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-recovery", updatedAt: 2 });
      await doctorCommand(output(), { repair: true, nonInteractive: true });
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-recovery");
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a pending set without its exact ledger run", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const scope = await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare("DELETE FROM update_runs WHERE run_id = ?")
        .run(run.runId);
      const runtime = output();
      await expect(doctorCommand(runtime, { repair: true, nonInteractive: true })).rejects.toThrow(
        "no matching update run exists",
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw update status --json"),
      );
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("before-update");
      await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
    });
  });

  it("restores a single unresolved failed update after its owner exits", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const original = await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      const migrated = { agentId: "main", sessionKey: "agent:main:migrated", env: state.env };
      await upsertSessionEntryCore(migrated, { sessionId: "migration-created", updatedAt: 2 });
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      await doctorCommand(output(), { repair: true, nonInteractive: true });
      expect(loadSessionEntryReadOnly(migrated)).toBeUndefined();
      expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rechecks settlement after maintenance drains stores before restoration", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "settled-update", updatedAt: 2 });
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      mocks.afterClose.mockImplementationOnce(async () => {
        await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
      });
      await expect(doctorCommand(output(), { repair: true, nonInteractive: true })).rejects.toThrow(
        "no longer eligible",
      );
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("settled-update");
      expect(
        JSON.parse(await fs.readFile(path.join(ref.directory, "outcome.json"), "utf8")),
      ).toMatchObject({ status: "committed" });
    });
  });
});
