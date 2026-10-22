import { vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ProducedPluginUpdateResult } from "./update-command-plugins-internals.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn(),
  doctor: vi.fn(),
  plugins: vi.fn(),
  convergence: vi.fn(),
}));
export { mocks };
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: async () => "skipped",
}));
// mock-isolation: repair fixtures must not run real plugin updates.
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./update-command-fresh-doctor.js", async (original) => ({
  ...(await original<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: mocks.doctor,
  completePostCorePluginUpdate: mocks.convergence,
}));
// mock-isolation: keep selection, finalization and SQLite real without live Doctor maintenance.
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => undefined,
}));
// mock-isolation: synthetic triage completion avoids external diagnostic collection.
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => async () => ({ status: "completed", hint: "" }),
}));

export const pluginResult: ProducedPluginUpdateResult = {
  assessment: { kind: "no-payload-repair" },
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};

export async function createRepairState(
  label: string,
  env: Record<string, string | undefined> = {},
) {
  vi.clearAllMocks();
  const state = await createOpenClawTestState({
    label,
    env: { OPENCLAW_UPDATE_RUN_ID: undefined, ...env },
  });
  await state.writeConfig({ plugins: { enabled: false }, update: { channel: "stable" } });
  mocks.root.mockResolvedValue(state.root);
  mocks.doctor.mockReset().mockResolvedValue(undefined);
  mocks.plugins.mockReset().mockResolvedValue(pluginResult);
  mocks.convergence.mockReset().mockImplementation(async ({ pluginUpdate }) => ({
    pluginUpdate,
    configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
  }));
  for (const method of ["log", "error", "writeJson"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => undefined);
  }
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  return state;
}
