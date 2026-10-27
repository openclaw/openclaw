import { afterEach, expect, it, vi } from "vitest";

const mocks = {
  check: vi.fn(),
  run: vi.fn(),
  writeJson: vi.fn(),
  log: vi.fn(),
};
const overrides = {
  "../../runtime.js": { defaultRuntime: mocks },
  "./shared.js": { resolveUpdateRoot: async () => "/fixture/openclaw" },
  "../../config/config.js": {
    readSourceConfigBestEffort: async () => ({ gateway: { mode: "remote" } }),
  },
  "../../commands/node-runtime-diagnostics.js": { collectNodeRuntimeFindings: async () => [] },
  "../../config/validation-core.js": { validateConfigObjectRaw: () => ({ ok: true }) },
  "../../infra/gateway-boot-lifecycle.js": {
    readGatewayLastInstallationReplacementAsync: async () => undefined,
  },
  "../../infra/package-update-activation.js": { readPackageActivationReceipt: () => undefined },
  "../../infra/update-check.js": {
    checkUpdateStatus: mocks.check,
    formatGitInstallLabel: () => undefined,
    compareSemverStrings: () => 0,
  },
  "../../infra/update-run-status.js": { readUpdateRunStatus: mocks.run },
  "../../infra/update-recovery-backup-status.js": { inspectUpdateRecoveryBackups: async () => [] },
  "../../infra/deferred-plugin-migrations.js": {
    readDeferredPluginMigrationsAsync: async () => [],
    formatDeferredPluginMigration: () => "",
  },
  "../../commands/doctor-session-sqlite-warnings.js": {
    readSessionSqliteMigrationWarnings: () => [],
  },
  "../../gateway/call.js": { callGateway: async () => ({}) },
  "../../infra/device-identity-async.js": { loadDeviceIdentityIfPresentAsync: async () => null },
  "../../infra/device-identity.js": { loadDeviceIdentityIfPresent: () => null },
  "../../infra/channels-status-issues.js": { collectChannelStatusIssues: () => [] },
};
for (const [module, exports] of Object.entries(overrides)) {
  vi.doMock(module, async (original) => Object.assign({}, await original(), exports));
}
vi.doMock("../../state/openclaw-state-db-readonly.js", async (original) => ({
  ...(await original<typeof import("../../state/openclaw-state-db-readonly.js")>()),
  ...(await import("../../state/artifact-preserving-state-reads.js")),
}));
const { updateStatusCommand } = await import("./status.js");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const lastRun = { runId: "completed-run", status: "succeeded" };
const delayed = <T>(value: T, ms: number) =>
  new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });

it("keeps history available when a short update-check timeout expires first", async () => {
  mocks.check.mockImplementation(() => delayed({ installKind: "unknown" }, 1000));
  mocks.run.mockImplementation(() => delayed({ lastRun }, 2000));
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
