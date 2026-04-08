import { afterEach, describe, expect, it, vi } from "vitest";
import { readLoggingConfig, setLoggingConfigLoaderForTests } from "./config.js";

const originalArgv = process.argv;
const loadLoggingConfigMock = vi.fn();

describe("readLoggingConfig", () => {
  afterEach(() => {
    process.argv = originalArgv;
    loadLoggingConfigMock.mockReset();
    setLoggingConfigLoaderForTests();
  });

  it("skips mutating config loads for config schema", async () => {
    process.argv = ["node", "openclaw", "config", "schema"];
    setLoggingConfigLoaderForTests(() => {
      throw new Error("loadLoggingConfig should not be called");
    });

    expect(readLoggingConfig()).toBeUndefined();
    expect(loadLoggingConfigMock).not.toHaveBeenCalled();
  });

  it("loads logging config lazily when reads are allowed", () => {
    setLoggingConfigLoaderForTests(() => {
      loadLoggingConfigMock();
      return {
        level: "debug",
        file: "/tmp/openclaw-YYYY-MM-DD.log",
      };
    });

    expect(readLoggingConfig()).toEqual({
      level: "debug",
      file: "/tmp/openclaw-YYYY-MM-DD.log",
    });
    expect(loadLoggingConfigMock).toHaveBeenCalledTimes(1);
  });
});
