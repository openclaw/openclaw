import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { triageCommand } from "./triage.js";
import {
  createTriageInferenceSelection,
  createTriageRuntime,
  withTriageTerminal,
} from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  turn: vi.fn(),
  selected: vi.fn(),
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
});
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.handoff = undefined;
});
it.each(["preserve", "verify-running"] as const)(
  "drains older admitted %s recovery as diagnostics without inference or maintenance",
  async (gateway) => {
    const runtime = createTriageRuntime();
    await withTriageTerminal(false, () =>
      triageCommand(
        runtime,
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
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.turn).not.toHaveBeenCalled();
    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("No repair agent was started.");
    expect(output).toContain("openclaw triage --run --update-result");
  },
);
