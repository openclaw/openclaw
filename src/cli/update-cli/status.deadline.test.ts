import { afterEach, expect, it, vi } from "vitest";
import { updateStatusCommand } from "./status.js";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  run: vi.fn(),
  writeJson: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks,
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => "/fixture/openclaw",
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readSourceConfigBestEffort: async () => ({ gateway: { mode: "remote" } }),
}));
vi.mock("../../commands/node-runtime-diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/node-runtime-diagnostics.js")>()),
  collectNodeRuntimeFindings: async () => [],
}));
vi.mock("../../config/validation-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/validation-core.js")>()),
  validateConfigObjectRaw: () => ({ ok: true }),
}));
vi.mock("../../infra/gateway-boot-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-boot-lifecycle.js")>()),
  readGatewayLastInstallationReplacementAsync: async () => undefined,
}));
vi.mock("../../infra/package-update-activation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/package-update-activation.js")>()),
  readPackageActivationReceipt: () => undefined,
}));
vi.mock("../../state/openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-db-readonly.js")>()),
  ...(await import("../../state/artifact-preserving-state-reads.js")),
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: mocks.check,
  formatGitInstallLabel: () => undefined,
  compareSemverStrings: () => 0,
}));
vi.mock("../../infra/update-run-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-status.js")>()),
  readUpdateRunStatus: mocks.run,
}));
vi.mock("../../infra/update-recovery-backup-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-recovery-backup-status.js")>()),
  inspectUpdateRecoveryBackups: async () => [],
}));
vi.mock("../../infra/deferred-plugin-migrations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/deferred-plugin-migrations.js")>()),
  readDeferredPluginMigrationsAsync: async () => [],
  formatDeferredPluginMigration: () => "",
}));
vi.mock("../../commands/doctor-session-sqlite-warnings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/doctor-session-sqlite-warnings.js")>()),
  readSessionSqliteMigrationWarnings: () => [],
}));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: async () => ({}),
}));
vi.mock("../../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-identity-async.js")>()),
  loadDeviceIdentityIfPresentAsync: async () => null,
}));
vi.mock("../../infra/device-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-identity.js")>()),
  loadDeviceIdentityIfPresent: () => null,
}));
vi.mock("../../infra/channels-status-issues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/channels-status-issues.js")>()),
  collectChannelStatusIssues: () => [],
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("keeps history available when a short update-check timeout expires first", async () => {
  const lastRun = { runId: "completed-run", status: "succeeded" };
  mocks.check.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ installKind: "unknown" }), 1000);
      }),
  );
  mocks.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ lastRun }), 2000);
      }),
  );
  vi.useFakeTimers();
  const pending = updateStatusCommand({ json: true, timeout: "1" });
  await vi.advanceTimersByTimeAsync(2001);
  await pending;
  expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
  expect(mocks.writeJson.mock.lastCall?.[0]).toMatchObject({ lastRun });
  expect(mocks.writeJson.mock.lastCall?.[0]).not.toHaveProperty("runStatusError");
});

it.each(["installation", "update history"])(
  "returns partial JSON at the overall deadline when %s never settles",
  async (section) => {
    const update = {
      root: "/fixture/openclaw",
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: "2026.9.8" },
    };
    mocks.check.mockResolvedValue(update);
    const lastRun = { runId: "completed-run", status: "succeeded" };
    mocks.run.mockResolvedValue({ lastRun });
    (section === "installation" ? mocks.check : mocks.run).mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    const pending = updateStatusCommand({ json: true });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(mocks.writeJson).toHaveBeenCalledOnce();
    expect(mocks.writeJson.mock.lastCall?.[0].inspectionErrors).toContainEqual({
      section,
      message: expect.stringMatching(/timed out.*30.*second/i),
    });
    if (section === "update history") {
      expect(mocks.writeJson.mock.lastCall?.[0].update).toEqual(update);
    } else {
      expect(mocks.writeJson.mock.lastCall?.[0]).toMatchObject({ lastRun });
    }
    await pending;
  },
);
