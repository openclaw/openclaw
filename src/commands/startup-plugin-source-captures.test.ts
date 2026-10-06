import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSnapshot } from "../config/mutate.test-support.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { resolvePluginSourceCaptureFallbackPrefix } from "../plugins/plugin-source-capture-path.js";
import { DoctorSqliteMaintenanceLockUnavailableError } from "./doctor-sqlite-maintenance-lock.js";
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
vi.mock("./doctor-sqlite-maintenance-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-sqlite-maintenance-lock.js")>()),
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
  vi.resetAllMocks();
  mocks.preserving = false;
  stateDir = temp.make("startup-capture-cleanup-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  await fs.mkdir(path.join(stateDir, "tmp", "plugin-captures"), { recursive: true });
  mocks.read.mockResolvedValue({
    snapshot: createSnapshot({
      hash: "fixture",
      sourceConfig: { meta: { migrations: { webhookListeners: true } } },
    }),
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

it("leaves capture reclamation to the Gateway post-ready owner", async () => {
  await expect(runStartupConfigPreflight({ gateway: true })).resolves.toHaveProperty(
    "snapshot.valid",
    true,
  );
  expect(mocks.verify).toHaveBeenCalledOnce();
  expect(mocks.maintenance).not.toHaveBeenCalled();
  expect(mocks.prune).not.toHaveBeenCalled();
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

it.each(["maintenance", "permission", "cleanup", "contention"])(
  "continues CLI startup after %s refusal, warning unless another process owns state",
  async (kind) => {
    const reason = "fixture capture cleanup unavailable";
    if (kind === "contention") {
      mocks.maintenance.mockRejectedValueOnce(
        new DoctorSqliteMaintenanceLockUnavailableError(
          "plugin source cleanup",
          new GatewayLockError(
            "failed to acquire gateway state ownership",
            new GatewayStateOwnerContentionError(path.join(stateDir, "state", "openclaw.sqlite")),
          ),
        ),
      );
    } else if (kind === "maintenance") {
      mocks.maintenance.mockRejectedValueOnce(new Error(reason));
    } else if (kind === "permission") {
      mocks.maintenance.mockRejectedValueOnce(
        new DoctorSqliteMaintenanceLockUnavailableError(
          "plugin source cleanup",
          new GatewayLockError(reason, Object.assign(new Error(reason), { code: "EACCES" })),
        ),
      );
    } else {
      mocks.prune.mockResolvedValueOnce({ removed: [], warnings: [reason] });
    }
    await expect(runStartupConfigPreflight({ gateway: false })).resolves.toHaveProperty(
      "snapshot.valid",
      true,
    );
    expect(mocks.maintenance).toHaveBeenCalledOnce();
    expect(mocks.prune).toHaveBeenCalledTimes(kind === "cleanup" ? 1 : 0);
    if (kind === "contention") {
      expect(mocks.warning).not.toHaveBeenCalled();
    } else {
      expect(mocks.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(reason));
    }
    expect(mocks.verify).not.toHaveBeenCalled();
  },
);

it.each(["selected", "other", "absent"])(
  "checks %s-profile fallback captures when the managed capture directory is absent",
  async (profile) => {
    await fs.rm(path.join(stateDir, "tmp"), { recursive: true });
    const systemTmp = temp.make("startup-fallback-system-tmp-");
    for (const key of ["TMPDIR", "TMP", "TEMP"]) {
      vi.stubEnv(key, systemTmp);
    }
    const selected = profile === "absent" ? path.join(stateDir, "absent") : stateDir;
    if (profile !== "absent") {
      const owner = profile === "selected" ? stateDir : path.join(stateDir, "other-profile");
      await fs.mkdir(
        path.join(systemTmp, `${resolvePluginSourceCaptureFallbackPrefix(owner)}fixture`),
      );
    }
    await cleanupStartupPluginSourceCaptures({ OPENCLAW_STATE_DIR: selected });
    if (profile === "absent") {
      await expect(fs.stat(selected)).rejects.toMatchObject({ code: "ENOENT" });
    }

    expect(mocks.maintenance).toHaveBeenCalledTimes(profile === "selected" ? 1 : 0);
    expect(mocks.prune).toHaveBeenCalledTimes(profile === "selected" ? 1 : 0);
    expect(mocks.warning).not.toHaveBeenCalled();
  },
);
