import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";

const loadConfigMock = vi.fn<() => OpenClawConfig>();
const readConfigFileSnapshotMock = vi.fn<() => Promise<ConfigFileSnapshot>>();
const cleanStaleMatrixPluginConfigMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../commands/doctor/providers/matrix.js", () => ({
  cleanStaleMatrixPluginConfig: (cfg: OpenClawConfig) => cleanStaleMatrixPluginConfigMock(cfg),
}));

const { loadConfigForInstall } = await import("./plugins-install-command.js");

function makeSnapshot(overrides: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/config.json5",
    exists: true,
    raw: '{ "plugins": {} }',
    parsed: { plugins: {} },
    resolved: { plugins: {} } as OpenClawConfig,
    valid: false,
    config: { plugins: {} } as OpenClawConfig,
    hash: "abc",
    issues: [{ path: "plugins.installs.matrix", message: "stale path" }],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

describe("loadConfigForInstall", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    readConfigFileSnapshotMock.mockReset();
    cleanStaleMatrixPluginConfigMock.mockReset();

    cleanStaleMatrixPluginConfigMock.mockImplementation((cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }));
  });

  it("returns the config directly when loadConfig succeeds", async () => {
    const cfg = { plugins: { entries: { matrix: { enabled: true } } } } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const result = await loadConfigForInstall();
    expect(result).toBe(cfg);
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("runs stale Matrix cleanup on the happy path", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    const cleanedCfg = { plugins: { cleaned: true } } as unknown as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    cleanStaleMatrixPluginConfigMock.mockReturnValue({ config: cleanedCfg, changes: ["cleaned"] });

    const result = await loadConfigForInstall();
    expect(cleanStaleMatrixPluginConfigMock).toHaveBeenCalledWith(cfg);
    expect(result).toBe(cleanedCfg);
  });

  it("falls back to snapshot config when loadConfig throws INVALID_CONFIG and snapshot was parsed", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    const snapshotCfg = {
      plugins: { installs: { matrix: { source: "path", installPath: "/gone" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { matrix: {} } } },
        config: snapshotCfg,
      }),
    );

    const result = await loadConfigForInstall();
    expect(readConfigFileSnapshotMock).toHaveBeenCalled();
    expect(cleanStaleMatrixPluginConfigMock).toHaveBeenCalledWith(snapshotCfg);
    expect(result).toBe(snapshotCfg);
  });

  it("throws when loadConfig fails with INVALID_CONFIG and snapshot parsed is empty (parse failure)", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {},
        config: {} as OpenClawConfig,
      }),
    );

    await expect(loadConfigForInstall()).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });

  it("throws when loadConfig fails with INVALID_CONFIG and config file does not exist", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot({ exists: false, parsed: {} }));

    await expect(loadConfigForInstall()).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });

  it("re-throws non-config errors from loadConfig", async () => {
    const fsErr = new Error("EACCES: permission denied");
    (fsErr as { code?: string }).code = "EACCES";
    loadConfigMock.mockImplementation(() => {
      throw fsErr;
    });

    await expect(loadConfigForInstall()).rejects.toThrow("EACCES: permission denied");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });
});
