import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readExperimentalConfigFlagStatesFromFile,
  writeExperimentalConfigFlagToFile,
  writeExperimentalConfigSelectionToFile,
} from "./experimental-config-file.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const transformConfigFileWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("./config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  transformConfigFileWithRetry: transformConfigFileWithRetryMock,
}));

type TransformParams<T = unknown> = {
  afterWrite?: unknown;
  transform: (currentConfig: Record<string, unknown>) => {
    nextConfig: unknown;
    result?: T;
  };
};

describe("experimental config file helpers", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockReset();
    validateConfigObjectWithPluginsMock.mockReset();
    transformConfigFileWithRetryMock.mockReset();
    validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
      ok: true,
      config,
      issues: [],
    }));
    transformConfigFileWithRetryMock.mockImplementation(async <T>(params: TransformParams<T>) => {
      const transformed = params.transform({});
      return {
        result: transformed.result,
        nextConfig: transformed.nextConfig,
      };
    });
  });

  it("rejects invalid config snapshots before listing flags", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: false,
      parsed: null,
    });

    await expect(readExperimentalConfigFlagStatesFromFile()).rejects.toThrow(
      "config file is invalid",
    );
  });

  it("rejects unknown experimental flag paths before writing", async () => {
    await expect(
      writeExperimentalConfigFlagToFile({
        path: "tools.experimental.missing",
        value: true,
      }),
    ).rejects.toThrow("unknown experimental flag");
    expect(transformConfigFileWithRetryMock).not.toHaveBeenCalled();
  });

  it("returns no-op when an authored disabled flag is already false", async () => {
    transformConfigFileWithRetryMock.mockImplementationOnce(
      async <T>(params: TransformParams<T>) => {
        params.transform({ tools: { experimental: { planTool: false } } });
      },
    );

    await expect(
      writeExperimentalConfigFlagToFile({
        path: "tools.experimental.planTool",
        value: false,
      }),
    ).resolves.toEqual({
      path: "tools.experimental.planTool",
      value: false,
      changed: false,
    });
  });

  it("surfaces validation failures without committing invalid experimental updates", async () => {
    validateConfigObjectWithPluginsMock.mockReturnValueOnce({
      ok: false,
      config: {},
      issues: [{ path: "tools.experimental.planTool", message: "bad boolean" }],
    });

    await expect(
      writeExperimentalConfigFlagToFile({
        path: "tools.experimental.planTool",
        value: false,
      }),
    ).rejects.toThrow(
      "config invalid after experimental update (tools.experimental.planTool: bad boolean)",
    );
  });

  it("writes picker selections through the same validated source transform", async () => {
    transformConfigFileWithRetryMock.mockImplementationOnce(
      async <T>(params: TransformParams<T>) => {
        const transformed = params.transform({});
        return { result: transformed.result };
      },
    );

    const result = await writeExperimentalConfigSelectionToFile({
      selectedPaths: new Set(["agents.defaults.experimental.localModelLean"]),
      afterWrite: { mode: "auto" },
    });

    expect(result.changed).toBe(true);
    expect(result.deltas.map((delta) => ({ path: delta.path, next: delta.next }))).toEqual([
      { path: "agents.defaults.experimental.localModelLean", next: true },
      { path: "agents.defaults.memorySearch.experimental.sessionMemory", next: false },
      { path: "tools.experimental.planTool", next: false },
    ]);
    expect(transformConfigFileWithRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "source",
        afterWrite: { mode: "auto" },
      }),
    );
  });
});
