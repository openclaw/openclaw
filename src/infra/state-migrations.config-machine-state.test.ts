import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { migrateLegacyConfigMachineState } from "./state-migrations.config-machine-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-config-machine-state-") };
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("legacy config machine-state migration", () => {
  it.each(["legacy", "both"])("imports %s TTS settings and keeps database state", (shape) => {
    writeConfigMachineState("config.lastTouchedAt", "canonical", { env });
    const result = migrateLegacyConfigMachineState({
      env,
      config: {
        meta: { lastTouchedVersion: "legacy", lastTouchedAt: "legacy-time" },
        hooks: { internal: { installs: { pack: { source: "npm" } } } },
        plugins: { bundledDiscovery: "compat" },
        ...(shape === "both" ? { tts: { prefsPath: "/tmp/tts.json" } } : {}),
        messages: {
          tts: { prefsPath: shape === "both" ? "/tmp/ignored-tts.json" : "/tmp/tts.json" },
        },
        cron: { store: "/tmp/jobs.json" },
      } as never,
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Kept existing shared SQLite config.lastTouchedAt state");
    for (const [key, value] of Object.entries({
      "config.lastTouchedAt": "canonical",
      "hooks.internal.installs": { pack: { source: "npm" } },
      "plugins.bundledDiscovery": "compat",
      "tts.prefsPath": "/tmp/tts.json",
      "cron.store": "/tmp/jobs.json",
    })) {
      expect(readConfigMachineState(key, { env })).toEqual(value);
    }
  });

  it("merges hook installs while canonical records win conflicts", () => {
    writeConfigMachineState(
      "hooks.internal.installs",
      { canonical: { source: "npm" }, shared: { source: "path" } },
      { env },
    );
    migrateLegacyConfigMachineState({
      env,
      config: {
        hooks: {
          internal: { installs: { legacy: { source: "archive" }, shared: { source: "archive" } } },
        },
      } as never,
    });
    expect(readConfigMachineState("hooks.internal.installs", { env })).toEqual({
      canonical: { source: "npm" },
      legacy: { source: "archive" },
      shared: { source: "path" },
    });
  });

  it.each([
    { lastTouchedVersion: undefined, expected: "compat" },
    { lastTouchedVersion: "2026.7.2", expected: undefined },
  ])(
    "infers bundled discovery for version $lastTouchedVersion",
    ({ lastTouchedVersion, expected }) => {
      migrateLegacyConfigMachineState({
        env,
        config: { meta: { lastTouchedVersion }, plugins: { allow: ["telegram"] } },
      });
      expect(readConfigMachineState("plugins.bundledDiscovery", { env })).toBe(expected);
    },
  );

  it("does not re-report inferred bundledDiscovery on a second beta-version pass", () => {
    const config = {
      meta: { lastTouchedVersion: "2026.7.2-beta.5" },
      plugins: { allow: ["telegram"] },
    };
    const first = migrateLegacyConfigMachineState({ env, config });
    expect(first.changes).toContain("Migrated plugins.bundledDiscovery → shared SQLite state");
    expect(readConfigMachineState("plugins.bundledDiscovery", { env })).toBe("compat");
    const second = migrateLegacyConfigMachineState({ env, config });
    expect(second.changes).not.toContain(
      "Kept existing shared SQLite plugins.bundledDiscovery state",
    );
    expect(readConfigMachineState("plugins.bundledDiscovery", { env })).toBe("compat");
  });
});
