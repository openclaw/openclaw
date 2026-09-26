import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSnapshot } from "../config/mutate.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";
import { cleanupStartupPluginSourceCaptures } from "./startup-plugin-source-captures.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  maintenance: vi.fn(),
  prune: vi.fn(),
  verify: vi.fn(),
  warning: vi.fn(),
  preserving: false,
}));

vi.mock("./config-preflight-snapshot.js", () => ({
  readConfigPreflightSnapshot: mocks.read,
  readAdmittedConfigSnapshot: mocks.read,
  needsRefreshedPluginIndexPersistence: () => false,
  assertPreflightConfigUnchanged: vi.fn(),
  persistRefreshedPluginIndex: vi.fn(),
}));
vi.mock("../infra/sqlite-readonly-worker.js", () => ({
  withSqliteReadOnlyWorkerScope: (run: () => unknown) => run(),
}));
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  isArtifactPreservingStateRead: () => mocks.preserving,
}));
vi.mock("./doctor-sqlite-maintenance-lock.js", () => ({
  withDoctorSqliteMaintenanceLock: mocks.maintenance,
}));
vi.mock("../plugins/plugin-source-capture-report.js", () => ({
  pruneUnreferencedPluginNativeCaptures: mocks.prune,
}));
vi.mock("./doctor-config-preflight-plugin-verification.js", () => ({
  refreshStartupPluginQuarantine: mocks.verify,
}));
vi.mock("../plugins/runtime-degraded-state.js", () => ({
  setActiveDegradedPlugins: vi.fn(),
}));
vi.mock("../infra/state-migrations.messages.js", () => ({
  recordStartupMigrationWarnings: vi.fn(),
}));

const temp = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let authorityLive = false;
const assertCurrent = () => {
  if (!authorityLive) {
    throw new Error("maintenance authority expired");
  }
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.preserving = false;
  stateDir = temp.make("startup-capture-cleanup-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  await fs.mkdir(path.join(stateDir, "tmp", "plugin-captures"), { recursive: true });
  mocks.read.mockResolvedValue({
    snapshot: createSnapshot({ hash: "fixture", sourceConfig: {} }),
  });
  mocks.verify.mockResolvedValue({ quarantinedPlugins: [] });
  mocks.prune.mockResolvedValue({ removed: [], warnings: [] });
  mocks.maintenance.mockImplementation(async ({ run }) => {
    authorityLive = true;
    try {
      return await run({ assertCurrent });
    } finally {
      authorityLive = false;
    }
  });
  vi.spyOn(process, "emitWarning").mockImplementation(mocks.warning);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("settles capture reclamation under custody before Gateway plugin verification", async () => {
  const started = createDeferred();
  const finish = createDeferred();
  mocks.prune.mockImplementationOnce(async (_state, assertAdmission) => {
    assertAdmission();
    started.resolve();
    await finish.promise;
    assertAdmission();
    return { removed: [], warnings: [] };
  });
  mocks.verify.mockImplementationOnce(async () => {
    expect(authorityLive).toBe(false);
    return { quarantinedPlugins: [] };
  });
  const startup = runStartupConfigPreflight({ gateway: true });
  expect(
    await Promise.race([
      started.promise.then(() => "cleanup"),
      startup.then(() => "startup complete"),
    ]),
  ).toBe("cleanup");
  expect(mocks.verify).not.toHaveBeenCalled();
  finish.resolve();
  await expect(startup).resolves.toHaveProperty("snapshot.valid", true);
  expect(mocks.verify).toHaveBeenCalledOnce();
  expect(mocks.prune).toHaveBeenCalledWith(stateDir, expect.any(Function), expect.any(Object), {
    startup: true,
  });
});

it("cleans up for CLI startup only after its state-preparation guard accepts", async () => {
  const guard = vi.fn(async () => false);
  await expect(
    runStartupConfigPreflight({ gateway: false, beforeStatePreparation: guard }),
  ).rejects.toThrow("selected config changed");
  expect(mocks.maintenance).not.toHaveBeenCalled();
  guard.mockResolvedValueOnce(true);
  await runStartupConfigPreflight({ gateway: false, beforeStatePreparation: guard });
  expect(mocks.prune).toHaveBeenCalledOnce();
});

it.each(["observe", "artifact-preserving"])(
  "leaves captures untouched during %s reads",
  async (kind) => {
    mocks.preserving = kind === "artifact-preserving";
    await runStartupConfigPreflight({
      gateway: false,
      ...(kind === "observe" ? { observe: false } : {}),
    });
    expect(mocks.maintenance).not.toHaveBeenCalled();
  },
);

it.each(["busy", "cleanup"])(
  "continues startup with one warning after %s refusal",
  async (kind) => {
    const reason = "fixture capture cleanup unavailable";
    if (kind === "busy") {
      mocks.maintenance.mockRejectedValueOnce(new Error(reason));
    } else {
      mocks.prune.mockResolvedValueOnce({ removed: [], warnings: [reason] });
    }
    await expect(runStartupConfigPreflight({ gateway: true })).resolves.toHaveProperty(
      "snapshot.valid",
      true,
    );
    expect(mocks.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(reason));
    expect(mocks.verify).toHaveBeenCalledOnce();
  },
);

it("does not acquire maintenance or create state for a profile without captures", async () => {
  const absent = path.join(stateDir, "absent");
  await cleanupStartupPluginSourceCaptures({ OPENCLAW_STATE_DIR: absent });
  expect(mocks.maintenance).not.toHaveBeenCalled();
  await expect(fs.stat(absent)).rejects.toMatchObject({ code: "ENOENT" });
});
