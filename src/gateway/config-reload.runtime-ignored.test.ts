import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "../config/io.factory.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushWatcherChange,
  prepareConfigReloadTest,
} from "./config-reload.test-support.js";

vi.mock("../config/io.audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.audit.js")>()),
  appendConfigAuditRecord: vi.fn(),
}));
vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config-journal-snapshot.js")>()),
  readLatestConfigSnapshotAuditRecordAsync: vi.fn(async () => null),
  upsertConfigSnapshotAuditRecordAsync: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(prepareConfigReloadTest);
afterEach(async () => {
  await closeTestConfigReloaders();
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("accepts ignored source edits quietly while retaining source revisions and real restart changes", async () => {
  const root = tempDirs.make("openclaw-reload-runtime-ignored-");
  const configPath = path.join(root, "openclaw.json");
  const io = createConfigIO({
    configPath,
    env: { OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_HOME: root },
    homedir: () => root,
    observe: false,
    pluginValidation: "core-only",
  });
  const writeAndRead = async (extra: Record<string, unknown>, port = 18789) => {
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { port, reload: {} }, ...extra }));
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    return snapshot;
  };
  const initial = await writeAndRead({ initialExtra: true });
  let current = initial;
  const runtimeConfig = {
    ...initial.runtimeConfig,
    gateway: { ...initial.runtimeConfig.gateway, auth: { token: "synthetic-runtime-only-token" } },
  };
  vi.useFakeTimers();
  const harness = createReloaderHarness(async () => current, {
    initialConfig: runtimeConfig,
    initialCompareConfig: initial.sourceConfig,
    initialRuntimeIgnoredPaths: initial.runtimeIgnoredPaths,
    initialSnapshotRawHash: hashConfigRaw(initial.raw),
    initialAuthoredConfig: initial.parsed,
  });
  await harness.reloader.ready;

  current = await writeAndRead({ replacementExtra: { retained: true } });
  await flushWatcherChange(harness);

  expect(harness.log.warn).not.toHaveBeenCalled();
  expect(harness.log.error).not.toHaveBeenCalled();
  expect(harness.onRestart).not.toHaveBeenCalled();
  expect(harness.onHotReload).not.toHaveBeenCalled();
  expect(harness.onEffectiveConfigUnchanged).not.toHaveBeenCalled();
  expect(harness.onNoopConfigCommit).toHaveBeenCalledWith(
    expect.objectContaining({ restartGateway: false, changedPaths: [] }),
    current.runtimeConfig,
    expect.objectContaining({ runtimeIgnoredPaths: current.runtimeIgnoredPaths }),
    current.sourceConfig,
  );
  expect(harness.onConfigRevisionApplied).toHaveBeenLastCalledWith(
    hashRuntimeConfigValue(current.sourceConfig),
  );
  expect(harness.onConfigCandidateCommitted).toHaveBeenLastCalledWith(
    expect.objectContaining({ persistedHash: current.hash }),
  );
  expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toHaveProperty(
    "replacementExtra.retained",
    true,
  );

  current = await writeAndRead({ replacementExtra: { retained: false } }, 18790);
  await flushWatcherChange(harness);
  expect(harness.onRestart).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ restartReasons: ["gateway.port"] }),
    current.runtimeConfig,
    expect.objectContaining({ runtimeIgnoredPaths: current.runtimeIgnoredPaths }),
    current.sourceConfig,
  );

  current = await writeAndRead({}, 18790);
  await flushWatcherChange(harness);
  expect(harness.onRestart).toHaveBeenCalledOnce();
  expect(harness.onConfigCandidateCommitted).toHaveBeenCalledTimes(3);
  expect(harness.onConfigRevisionApplied).toHaveBeenLastCalledWith(
    hashRuntimeConfigValue(current.sourceConfig),
  );
  expect(harness.log.warn).not.toHaveBeenCalled();
  expect(harness.log.error).not.toHaveBeenCalled();
});
