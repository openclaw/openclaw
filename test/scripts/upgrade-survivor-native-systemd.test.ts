import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNativeUnit,
  assertNativeUpdate,
  planNativeUpgradeSurvivor,
  prepareNativeRuntimePath,
} from "../../scripts/e2e/lib/upgrade-survivor/native-systemd-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("native upgrade survivor", () => {
  it("runs the selected Node from the fixture's own runtime", () => {
    const runtime = realpathSync(tempDirs.make("survivor-native-runtime-"));
    const result = spawnSync(
      "node",
      ["-p", "JSON.stringify({version:process.version,execPath:process.execPath})"],
      { env: { PATH: prepareNativeRuntimePath(runtime) }, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: process.version,
      execPath: path.join(runtime, "node"),
    });
  });

  it("selects sequential systemd cells with restart enabled and the extended-channel hop", () => {
    expect(planNativeUpgradeSurvivor()).toEqual([
      { flow: "systemd", baseline: "openclaw@2026.10.9", version: "2026.10.9", updateArgs: [] },
    ]);
    expect(planNativeUpgradeSurvivor({ baselines: ["2026.10.9", "2026.9.36"] })[1]).toEqual({
      flow: "systemd",
      baseline: "openclaw@2026.9.36",
      version: "2026.9.36",
      updateArgs: ["--channel", "stable"],
    });
    expect(() => planNativeUpgradeSurvivor({ flow: "manual" })).toThrow("Unknown native");
    expect(() => planNativeUpgradeSurvivor({ baselines: ["latest"] })).toThrow("exact published");
  });

  it("rejects manual starts and failed updates even when candidate RPC is healthy", () => {
    const unit = {
      ActiveState: "active",
      SubState: "running",
      MainPID: "200",
      FragmentPath: "/home/fixture/.config/systemd/user/openclaw-gateway.service",
      ControlGroup:
        "/user.slice/user-1001.slice/user@1001.service/app.slice/openclaw-gateway.service",
    };
    const candidate = { version: "2026.10.9", buildId: "candidate-build" };
    const result = {
      status: "ok",
      run: {
        status: "succeeded",
        verification: {
          serviceRunning: true,
          versionMatch: true,
          channelsReady: true,
          readyz: true,
          coreReady: true,
          settled: true,
          pluginErrors: [],
          pid: 200,
        },
      },
      steps: [{ name: "gateway verification", exitCode: 0 }],
    };
    const evidence = {
      result,
      before: { ...unit, MainPID: "100" },
      after: unit,
      rpc: { rpc: { ok: true, server: candidate } },
      candidate,
    };
    expect(() => assertNativeUnit(unit, { home: "/home/fixture", uid: "1001" })).not.toThrow();
    expect(() => assertNativeUpdate(evidence)).not.toThrow();
    expect(() =>
      assertNativeUnit(
        { ...unit, ControlGroup: "/fixture" },
        { home: "/home/fixture", uid: "1001" },
      ),
    ).toThrow("native user manager");
    expect(() =>
      assertNativeUpdate({
        ...evidence,
        result: { ...result, status: "error", reason: "state-migrated-no-rollback" },
      }),
    ).toThrow("state-migrated-no-rollback");
    expect(() => assertNativeUpdate({ ...evidence, result: { ...result, steps: [] } })).toThrow(
      "verify its restart",
    );
    expect(() => assertNativeUpdate({ ...evidence, before: unit })).toThrow("did not change");
    expect(() =>
      assertNativeUpdate({ ...evidence, candidate: { ...candidate, buildId: "other-build" } }),
    ).toThrow("Serving build");
  });
});
