import { afterEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

const originalArgv = process.argv;

describe("readLoggingConfig", () => {
  afterEach(() => {
    process.argv = originalArgv;
    loadConfigMock.mockReset();
  });

  it("skips mutating config loads for config schema", async () => {
    process.argv = ["node", "openclaw", "config", "schema"];
    loadConfigMock.mockImplementation(() => {
      throw new Error("loadConfig should not be called");
    });

    const { readLoggingConfig } = await import("./config.js");

    expect(readLoggingConfig()).toBeUndefined();
    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});
