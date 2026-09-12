import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { createCompatibilityNotice } from "../plugins/status.test-fixtures.js";
import { requireValidConfig, requireValidConfigForWrite } from "./config-validation.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const {
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  buildPluginCompatibilitySnapshotNotices,
} = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  buildPluginCompatibilitySnapshotNotices: vi.fn<
    (_params?: unknown) => PluginCompatibilityNotice[]
  >(() => []),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice: (notice: { pluginId: string; message: string }) =>
    `${notice.pluginId} ${notice.message}`,
}));

describe("requireValidConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createValidSnapshot() {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { plugins: {} },
      issues: [],
    });
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([
      createCompatibilityNotice({ pluginId: "legacy-plugin", code: "hook-only" }),
    ]);
  }

  it("retains native write ownership and the read-time environment after an await", async () => {
    const writeSnapshot = {
      snapshot: {
        exists: true,
        valid: true,
        config: {},
        sourceConfig: {},
        path: "/tmp/owned.json",
      },
      writeOptions: {
        expectedConfigPath: "/tmp/owned.json",
        envSnapshotForRestore: { CONFIG_READ_TOKEN: "at-read" },
        includeFileHashesForWrite: { "/tmp/include.json": "read-hash" },
      },
    };
    readConfigFileSnapshotForWrite.mockResolvedValue(writeSnapshot);
    const result = await requireValidConfigForWrite(createTestRuntime());
    await Promise.resolve();
    expect(result).toBe(writeSnapshot);
    expect(result?.writeOptions.envSnapshotForRestore).toEqual({ CONFIG_READ_TOKEN: "at-read" });
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("reports invalid native write reads without returning a writable snapshot", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        path: "/tmp/owned.json",
        exists: true,
        valid: false,
        raw: "{}",
        parsed: {},
        sourceConfig: {},
        config: {},
        issues: [{ path: "gateway.mode", message: "Invalid mode" }],
        legacyIssues: [],
      },
      writeOptions: { expectedConfigPath: "/tmp/owned.json" },
    });
    const runtime = createTestRuntime();
    expect(await requireValidConfigForWrite(runtime)).toBeNull();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith("Fix: openclaw doctor --fix");
  });

  it("returns config without emitting compatibility advice by default", async () => {
    createValidSnapshot();
    const runtime = createTestRuntime();

    const config = await requireValidConfig(runtime);

    expect(config).toEqual({ plugins: {} });
    expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(buildPluginCompatibilitySnapshotNotices).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("can validate core config without loading plugin schemas", async () => {
    createValidSnapshot();
    const runtime = createTestRuntime();

    await expect(requireValidConfig(runtime, { skipPluginValidation: true })).resolves.toEqual({
      plugins: {},
    });

    expect(readConfigFileSnapshot).toHaveBeenCalledWith({ skipPluginValidation: true });
  });

  it("can validate config without observing persistent health state", async () => {
    createValidSnapshot();
    const runtime = createTestRuntime();

    await expect(requireValidConfig(runtime, { observe: false })).resolves.toEqual({
      plugins: {},
    });

    expect(readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
  });

  it("emits a non-blocking compatibility advisory when explicitly requested", async () => {
    createValidSnapshot();
    const runtime = createTestRuntime();

    const config = await requireValidConfig(runtime, {
      includeCompatibilityAdvisory: true,
    });

    expect(config).toEqual({ plugins: {} });
    expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log.mock.calls[0]?.[0]).toBe(
      [
        "Plugin compatibility: 1 notice.",
        "- legacy-plugin is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
        "Review: openclaw doctor",
      ].join("\n"),
    );
  });

  it("blocks invalid config before emitting compatibility advice", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: false,
      raw: "{}",
      parsed: {},
      sourceConfig: {},
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });
    const runtime = createTestRuntime();

    const config = await requireValidConfig(runtime, {
      includeCompatibilityAdvisory: true,
    });

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("replaces doctor fix advice for plugin packaging compiled-output failures", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: false,
      raw: "{}",
      parsed: {},
      sourceConfig: {},
      config: {},
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
        },
      ],
      legacyIssues: [],
    });
    const runtime = createTestRuntime();

    const config = await requireValidConfig(runtime);

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("plugin not found"));
    expect(runtime.error).toHaveBeenCalledWith(
      "Fix: This is a plugin packaging issue, not a local config problem.\nUpdate or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
    );
    expect(runtime.error).not.toHaveBeenCalledWith("Fix: openclaw doctor --fix");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps doctor fix advice for normal invalid config failures", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: false,
      raw: "{}",
      parsed: {},
      sourceConfig: {},
      config: {},
      issues: [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }],
      legacyIssues: [],
    });
    const runtime = createTestRuntime();

    const config = await requireValidConfig(runtime);

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith("Fix: openclaw doctor --fix");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
