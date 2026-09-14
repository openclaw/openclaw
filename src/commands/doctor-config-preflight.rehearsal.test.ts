import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createDoctorRehearsalSnapshotPreparation,
  readDoctorConfigPreflightSnapshot,
} from "./doctor-config-preflight-plugin-index.js";

const fixture = vi.hoisted(() => ({
  events: [] as string[],
  complete: vi.fn(async () => ({ copiedFiles: 2, warnings: ["fixture advisory"] })),
  snapshot: {
    path: "/fixture/openclaw.json",
    exists: true,
    valid: true,
    raw: "{}",
    parsed: {},
    sourceConfig: {},
    resolved: {},
    config: {},
    runtimeConfig: {},
    issues: [],
    warnings: [],
    legacyIssues: [],
  } satisfies ConfigFileSnapshot,
}));
vi.mock("../infra/update-candidate-plugin-repair.js", () => ({
  completeUpdateCandidatePluginRehearsal: fixture.complete,
}));
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: async () => {
    fixture.events.push("read");
    return fixture.snapshot;
  },
  readConfigFileSnapshotWithPluginMetadata: vi.fn(),
}));
vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: () => ({}),
}));
vi.mock("./doctor/shared/legacy-config-issues.js", () => ({
  addDoctorLegacyIssues: (snapshot: ConfigFileSnapshot) => {
    fixture.events.push("inspect");
    return snapshot;
  },
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  fixture.events.length = 0;
  fixture.complete
    .mockReset()
    .mockResolvedValue({ copiedFiles: 2, warnings: ["fixture advisory"] });
});
function env() {
  return {
    ...buildUpdateRehearsalPathEnv(dirs.make("preflight-rehearsal-")),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  };
}
function read(prepareSnapshot?: (snapshot: ConfigFileSnapshot) => Promise<void>) {
  return readDoctorConfigPreflightSnapshot({
    allowCurrentPluginMetadata: false,
    includePluginMetadata: false,
    preparePluginMetadataSnapshot: false,
    skipPluginValidation: true,
    prepareSnapshot,
  });
}
describe("Doctor preflight rehearsal preparation", () => {
  it.each(["ordinary", "missing-root-contract", "finished-phase", "truthy-not-exact"] as const)(
    "does not prepare a snapshot for %s",
    async (kind) => {
      const overrides = env();
      if (kind === "missing-root-contract") {
        overrides.OPENCLAW_SERVICE_REPAIR_POLICY = "ordinary";
      }
      if (kind === "finished-phase") {
        overrides.OPENCLAW_UPDATE_IN_PROGRESS = "0";
      }
      if (kind === "truthy-not-exact") {
        overrides.OPENCLAW_UPDATE_IN_PROGRESS = "true";
      }
      await withEnvAsync(overrides, async () => {
        const prepare = createDoctorRehearsalSnapshotPreparation(vi.fn());
        const callback = prepare(kind !== "ordinary");
        expect(callback).toBeUndefined();
        await read(callback);
        expect(fixture.complete).not.toHaveBeenCalled();
      });
    },
  );
  it("awaits preparation before contract inspection and reports once across current-phase rereads", async () => {
    await withEnvAsync(env(), async () => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      fixture.complete.mockImplementationOnce(async () => {
        fixture.events.push("prepare");
        entered.resolve();
        await release.promise;
        fixture.events.push("completed");
        return { copiedFiles: 2, warnings: ["fixture advisory"] };
      });
      const report = vi.fn();
      const prepare = createDoctorRehearsalSnapshotPreparation(report);
      const pending = read(prepare(true));
      await entered.promise;
      try {
        expect(fixture.events).toEqual(["read", "prepare"]);
        expect(report).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      await pending;
      await read(prepare(true));
      expect(fixture.events).toEqual([
        "read",
        "prepare",
        "completed",
        "inspect",
        "read",
        "inspect",
      ]);
      expect(fixture.complete).toHaveBeenCalledExactlyOnceWith({
        config: fixture.snapshot.sourceConfig,
        env: process.env,
        installRecords: {},
      });
      expect(report).toHaveBeenCalledExactlyOnceWith({
        changes: ["Update rehearsal: copied 2 missing plugin dependency files."],
        warnings: ["fixture advisory"],
      });
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = "0";
      expect(prepare(true)).toBeUndefined();
      const nextPreflight = createDoctorRehearsalSnapshotPreparation(vi.fn());
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
      await read(nextPreflight(true));
      expect(fixture.complete).toHaveBeenCalledTimes(2);
    });
  });
  it("propagates preparation failure without inspection, reporting, or marking completion", async () => {
    await withEnvAsync(env(), async () => {
      fixture.complete.mockRejectedValueOnce(new Error("fixture preparation refused"));
      const report = vi.fn();
      const prepare = createDoctorRehearsalSnapshotPreparation(report);
      await expect(read(prepare(true))).rejects.toThrow("fixture preparation refused");
      expect(fixture.events).toEqual(["read"]);
      expect(report).not.toHaveBeenCalled();
      await read(prepare(true));
      expect(fixture.complete).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenCalledTimes(1);
    });
  });
});
