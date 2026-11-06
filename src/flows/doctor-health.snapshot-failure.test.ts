import "./doctor-health.test-support.js";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { expect, it, vi } from "vitest";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { doctorCommand } from "../commands/doctor.js";
import { settleSqliteSnapshotRequest } from "../infra/sqlite-readonly-location-cleanup.js";
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
