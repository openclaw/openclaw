import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { importConfigMachineState, writeConfigMachineState } from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

describe("machine-state import", () => {
  it("publishes newly imported paths and keeps the first canonical value", () => {
    const options = {
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("machine-state-") },
    };
    writeConfigMachineState("config.lastTouchedAt", "canonical", options);
    expect(readConfigMachineState("tts.prefsPath", options)).toBeUndefined();

    expect(
      importConfigMachineState(
        [
          ["tts.prefsPath", "/tmp/first-tts.json"],
          ["tts.prefsPath", "/tmp/ignored-tts.json"],
          ["config.lastTouchedAt", "legacy"],
        ],
        options,
      ),
    ).toEqual({
      imported: ["tts.prefsPath"],
      kept: ["tts.prefsPath", "config.lastTouchedAt"],
    });

    expect(readConfigMachineState("tts.prefsPath", options)).toBe("/tmp/first-tts.json");
    expect(readConfigMachineState("config.lastTouchedAt", options)).toBe("canonical");
  });
});
