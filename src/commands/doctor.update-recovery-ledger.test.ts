import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeUpdateCommandBackup } from "../cli/update-cli/update-command-backup-lifecycle.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  createUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../infra/update-recovery-backup.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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
  it("preserves new sessions after successful update outcome publication fails", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      const rename = fs.rename;
      const publication = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === path.join(ref.directory, "outcome.json")) {
          throw new Error("synthetic outcome publication failure");
        }
        await rename(from, to);
      });
      try {
        await completeUpdateCommandBackup(
          { root: state.path("install"), updateRecoveryBackup: ref },
          { status: "ok", mode: "npm", steps: [], durationMs: 0 },
          () => authority.assertOwned(),
        );
      } finally {
        publication.mockRestore();
      }
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
      expect(
        JSON.parse(await fs.readFile(path.join(ref.directory, "outcome.json"), "utf8")).status,
      ).toBe("pending");
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-update", updatedAt: 2 });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      const runtime = output();
      await doctorCommand(runtime, { repair: true, nonInteractive: true });
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-update");
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(ref.manifestPath));
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("stale"));
      expect(
        JSON.parse(await fs.readFile(path.join(ref.directory, "outcome.json"), "utf8")),
      ).toMatchObject({ status: "committed" });
    });
  });

  it("retains and reports an unresolved recovery after three newer backups and owner exit", async () => {
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
      for (let index = 0; index < 3; index++) {
        const later = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const next = await createUpdateRecoveryBackup({
          ...authority,
          runId: later.runId,
          installRoot: state.path("install"),
        });
        await writeUpdateRecoveryBackupOutcome(next, { status: "committed" }, authority);
        finishUpdateRun(later.runId, { status: "succeeded" }, { env: state.env });
      }
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
      const runtime = output();
      await expect(doctorCommand(runtime, { repair: true, nonInteractive: true })).rejects.toThrow(
        "openclaw update status --json",
      );
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(ref.manifestPath));
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("npx openclaw@latest doctor --fix"),
      );
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
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
      expect(
        JSON.parse(await fs.readFile(path.join(ref.directory, "outcome.json"), "utf8")),
      ).toMatchObject({ status: "restored" });
    });
  });

  it("refuses a pending set without its exact ledger run", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const scope = await prepareState(state);
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: randomUUID(),
        installRoot: state.path("install"),
      });
      const runtime = output();
      await expect(doctorCommand(runtime, { repair: true, nonInteractive: true })).rejects.toThrow(
        "no matching update run exists",
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw update status --json"),
      );
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("before-update");
      expect(
        JSON.parse(await fs.readFile(path.join(ref.directory, "outcome.json"), "utf8")),
      ).toMatchObject({ status: "pending" });
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
      expect(
        JSON.parse(await fs.readFile(path.join(ref.directory, "outcome.json"), "utf8")),
      ).toMatchObject({ status: "restored" });
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
