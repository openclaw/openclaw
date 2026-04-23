import { afterEach, describe, expect, it, vi } from "vitest";

const readBestEffortLoggingConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./config-loader.js", () => ({
  readBestEffortLoggingConfig: readBestEffortLoggingConfigMock,
}));

import { readLoggingConfig } from "./config.js";

const originalArgv = process.argv;

describe("readLoggingConfig", () => {
  afterEach(() => {
    process.argv = originalArgv;
    readBestEffortLoggingConfigMock.mockReset();
  });

  it("skips mutating config loads for config schema", async () => {
    process.argv = ["node", "openclaw", "config", "schema"];

    expect(readLoggingConfig()).toBeUndefined();
    expect(readBestEffortLoggingConfigMock).not.toHaveBeenCalled();
  });

  it("delegates to the best-effort loader for regular commands", async () => {
    process.argv = ["node", "openclaw", "gateway", "run"];
    readBestEffortLoggingConfigMock.mockReturnValue({ level: "debug" });

    expect(readLoggingConfig()).toEqual({ level: "debug" });
    expect(readBestEffortLoggingConfigMock).toHaveBeenCalledTimes(1);
  });
});
