import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runAutomaticTriageRepair } from "./triage-automatic-repair.js";
import { triageCommand } from "./triage.js";
import {
  createTriageInferenceSelection,
  createTriageRuntime,
  withTriageTerminal,
} from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  turn: vi.fn(),
  selected: vi.fn(),
  maintenance: vi.fn(),
  handoff: undefined as ReturnType<typeof createManagedHandoffTestBinding> | undefined,
}));
vi.mock("./doctor-lint-runner.js", () => ({ collectDoctorFindings: async () => [] }));
vi.mock("./triage-update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./triage-update.js")>()),
  readPendingTriageUpdateFailure: async () => undefined,
}));
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({
    exists: true,
    valid: true,
    config: { agents: { defaults: { model: "fixture/repair" } } },
  }),
}));
vi.mock("../infra/executable-path.js", () => ({ resolveExecutablePath: () => undefined }));
vi.mock("../infra/update-repair-agent.runtime.js", () => ({
  prepareUpdateRepairInference: mocks.selected,
  runUpdateRepairTurn: mocks.turn,
}));
vi.mock("../infra/update-repair-maintenance.js", () => ({
  runUpdateRepairMaintenance: mocks.maintenance,
}));
vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: () => {
    if (!mocks.handoff) {
      throw new Error("Private handoff binding required");
    }
    mocks.handoff.assertPath();
    return mocks.handoff.directory;
  },
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  stateDir = tempDirs.make("triage-maintenance-");
  mocks.handoff = createManagedHandoffTestBinding(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv(
    "NODE_OPTIONS",
    [process.env.NODE_OPTIONS, mocks.handoff.nodeOption].filter(Boolean).join(" "),
  );
  mocks.handoff.assertPath(resolveManagedUpdateLeaseDatabasePath());
  mocks.selected.mockResolvedValue(createTriageInferenceSelection(stateDir));
  mocks.maintenance.mockResolvedValue({
    termination: "exit",
    code: 0,
    stdout: "Maintenance result",
    stderr: "",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.handoff = undefined;
});
const completed = {
  status: "completed",
  envelope: { status: "ok", final: "" },
  maintenance: { operation: "update-repair" },
};
function run(gateway: "preserve" | "verify-running" = "preserve") {
  return withTriageTerminal(false, () =>
    triageCommand(
      createTriageRuntime(),
      { noExport: true },
      {
        failure: {
          kind: "update",
          phase: "doctor",
          error: "original failure",
          installationRoot: stateDir,
          gateway,
        },
        signal: new AbortController().signal,
        assertCurrent: () => {},
      },
    ),
  );
}

it.each(["preserve", "verify-running"] as const)(
  "settles the automatic repair turn before maintenance with %s intent",
  async (gateway) => {
    const entered = createDeferredCore();
    const settled = createDeferredCore<typeof completed>();
    mocks.turn.mockImplementation(async (params) => {
      expect(params.maintenanceHandoff).toBe(true);
      expect(params.prompt).toContain("Never run Doctor maintenance or update repair through exec");
      expect(params.prompt).toContain(
        gateway === "preserve"
          ? "Do not start or restart the Gateway"
          : "Only activate a Gateway intended to run",
      );
      entered.resolve();
      return settled.promise;
    });
    const pending = run(gateway);
    await entered.promise;
    expect(mocks.maintenance).not.toHaveBeenCalled();
    settled.resolve(completed);
    await pending;
    expect(mocks.maintenance).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        request: { operation: "update-repair" },
        allowGatewayActivation: gateway === "verify-running",
        target: expect.objectContaining({ installRoot: stateDir, stateDir }),
      }),
    );
  },
);

it.each(["error", "timeout", "cleanup"])(
  "never starts maintenance after a %s turn",
  async (failure) => {
    if (failure === "cleanup") {
      mocks.turn.mockRejectedValue(new Error("resource cleanup failed"));
    } else {
      mocks.turn.mockResolvedValue({ ...completed, envelope: { status: failure, final: "" } });
    }
    await expect(run()).rejects.toBeDefined();
    expect(mocks.maintenance).not.toHaveBeenCalled();
  },
);

it("preserves a failed maintenance command as failure", async () => {
  mocks.turn.mockResolvedValue(completed);
  mocks.maintenance.mockResolvedValue({
    termination: "exit",
    code: 1,
    stdout: "",
    stderr: "Agent database is still open",
  });
  await expect(run()).rejects.toMatchObject({ code: 1 });
  expect(mocks.maintenance).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "maintenance outlives the agent deadline but retains owner cancellation (cancel=%s)",
  async (cancel) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const owner = new AbortController();
    mocks.turn.mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(599_999);
      return completed;
    });
    mocks.maintenance.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      await vi.advanceTimersByTimeAsync(2);
      expect(signal.aborted).toBe(false);
      if (cancel) {
        owner.abort(new Error("owner cancelled"));
        expect(signal.aborted).toBe(true);
      }
      return { termination: "exit", code: 0, stdout: "", stderr: "" };
    });
    try {
      const pending = runAutomaticTriageRepair({
        runtime: createTriageRuntime(),
        target: {
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          defaultWorkspaceDir: stateDir,
        },
        targetEnv: { OPENCLAW_STATE_DIR: stateDir },
        installRoot: stateDir,
        prompt: "Repair.",
        signal: owner.signal,
        allowGatewayActivation: false,
        isCurrent: () => true,
        formatError: String,
      });
      if (cancel) {
        await expect(pending).rejects.toThrow("owner cancelled");
      } else {
        await pending;
      }
      expect(mocks.maintenance).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);
