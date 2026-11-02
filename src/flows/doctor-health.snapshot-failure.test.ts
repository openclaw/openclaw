import "./doctor-health.test-support.js";
import fs from "node:fs";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { expect, it, onTestFinished, vi } from "vitest";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { doctorCommand } from "../commands/doctor.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { settleSqliteSnapshotRequest } from "../infra/sqlite-readonly-location-cleanup.js";
import * as sqliteWorker from "../infra/sqlite-readonly-worker.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { readOpenClawDatabaseQuarantineFailure } from "../state/openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.test-support.js";
import { resolveQuarantineStorePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";

const { mocks } = await import("./doctor-health.test-support.js");
useDoctorHealthFixture();

it("exits nonzero when an optional check defers a failed native snapshot request", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const failure = new Error("SQLite snapshot allocation denied by the sandbox");
    const cleanup = createRetainedOperation<void>(() => {});
    cleanup.resolve();
    mocks.runContributions.mockImplementation(async (ctx) => {
      try {
        await settleSqliteSnapshotRequest({
          result: Promise.reject(failure),
          startClose: () => cleanup.operation,
        });
      } catch {
        ctx.runtime.log("Optional cron ownership inspection deferred; existing rows retained.");
      }
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await runCommandWithRuntime(runtime, () => doctorCommand(runtime, { nonInteractive: true }));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("inspection deferred"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(failure.message));
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
  });
});

it("reports a refused historical quarantine inspection instead of blocking or treating it as healthy", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.path("historical-agent.sqlite");
    fs.writeFileSync(pathname, "");
    seedOpenClawDatabaseQuarantine({
      env: state.env,
      path: pathname,
      kind: "agent",
      reason: "historically verified damage",
      generation: readStableSqliteFileGeneration(pathname),
    });
    const files = [pathname, resolveQuarantineStorePath(state.env)];
    const before = files.map((file) => fs.readFileSync(file));
    const synchronous = vi.spyOn(sqliteWorker, "runSqliteReadOnlyWorkerSync");
    onTestFinished(() => synchronous.mockRestore());
    const read = vi.fn(() => "unreachable");
    mocks.runContributions.mockImplementation(async () => {
      withOpenClawAgentDatabaseReadOnly(read, { agentId: "main", path: pathname, env: state.env });
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await runCommandWithRuntime(runtime, () => doctorCommand(runtime, { nonInteractive: true }));
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Doctor refused synchronous SQLite preparation"),
    );
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.runContributions).toHaveBeenCalledOnce();
    expect(synchronous).toHaveBeenCalledWith(pathname, undefined, "file-generation");
    expect(read).not.toHaveBeenCalled();
    expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    expect(
      readOpenClawDatabaseQuarantineFailure("agent", pathname, { env: state.env }),
    ).toMatchObject({
      name: "SqliteIntegrityError",
      message: expect.stringContaining("historically verified damage"),
    });
    expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
  });
});
