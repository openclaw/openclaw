import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { createManagedHandoffRecoveryFixture } from "../../infra/update-managed-service-handoff-recovery.test-support.js";
import { listUpdateRuns } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import { registerUpdateCli } from "../update-cli.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { ProducedPluginUpdateResult } from "./update-command-plugins-internals.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn(),
  doctor: vi.fn(),
  plugins: vi.fn(),
  convergence: vi.fn(),
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: async () => "skipped",
}));
vi.mock("../../infra/update-check.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-check.js")>()),
  resolveUpdateInstallKind: async () => "package",
}));
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./update-command-fresh-doctor.js", async (original) => ({
  ...(await original<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: mocks.doctor,
  completePostCorePluginUpdate: mocks.convergence,
}));
// Keep the registered command, finalizer lifecycle, handoff owner, and ledger real.
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => undefined,
}));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => async () => ({ status: "completed", hint: "" }),
}));

const pluginResult: ProducedPluginUpdateResult = {
  assessment: { kind: "no-payload-repair" },
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
let state: OpenClawTestState;
let fixture: ReturnType<typeof createManagedHandoffRecoveryFixture>;

beforeEach(async () => {
  vi.clearAllMocks();
  state = await createOpenClawTestState({
    label: "repair-handoff",
    env: {
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
      OPENCLAW_UPDATE_POST_CORE: undefined,
    },
  });
  fixture = createManagedHandoffRecoveryFixture(state.root);
  await state.writeConfig({ plugins: { enabled: false }, update: { channel: "stable" } });
  await fs.writeFile(
    state.path("package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0" }),
  );
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

it("registered update repair settles a dead uncertain lease and admits the next updater", async () => {
  fixture.seed();
  mocks.doctor.mockImplementation(async () => {
    expect(fixture.readMetadata(fixture.current())?.facts.runIds).toEqual([
      "retained-update",
      listUpdateRuns()[0]?.runId,
    ]);
  });
  await expect(
    withUpdateCommandExecutor("blocked-before-repair", async (executor) => {
      await executor.enter(state.root);
    }),
  ).rejects.toThrow("Another update executor owns this installation");

  await withCliProcessScope(() =>
    runRegisteredCli({
      register: registerUpdateCli,
      argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
    }),
  );

  expect(mocks.doctor).toHaveBeenCalledOnce();
  expect(mocks.plugins).toHaveBeenCalledOnce();
  expect(fixture.store.read(state.root)).toEqual({ kind: "absent" });
  const runs = listUpdateRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    status: "succeeded",
    steps: expect.arrayContaining([
      expect.objectContaining({
        step: "finalize:handoff-settlement",
        status: "completed",
        detail: expect.stringContaining("legacy handoff lease reclaimed"),
      }),
    ]),
  });
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
  await expect(
    withUpdateCommandExecutor("next-update", async (executor) => {
      const fence = await executor.enter(state.root);
      fence.assertCurrent();
      return "admitted";
    }),
  ).resolves.toBe("admitted");
});

it("does not reclaim a handoff from a programmatic call without CLI process ownership", async () => {
  const retained = fixture.seed();
  await runRegisteredCli({
    register: registerUpdateCli,
    argv: ["update", "repair", "--yes", "--json", "--timeout", "15"],
  });
  expect(fixture.current()).toEqual(retained);
  expect(
    listUpdateRuns()[0]?.steps.some((step) => step.step === "finalize:handoff-settlement"),
  ).toBe(false);
});
