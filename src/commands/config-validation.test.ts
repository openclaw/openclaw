import { beforeEach, describe, expect, it, vi } from "vitest";
import { withConsoleLogsRoutedToStderrForJson } from "../cli/json-output-mode.js";
import { requireValidConfig, requireValidConfigForWrite } from "./config-validation.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const { readConfigFileSnapshot, readConfigFileSnapshotForWrite } = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
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
  }

  it.each([true])("retains native write ownership after an await (json=%s)", async (json) => {
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
    const runtime = createTestRuntime();
    const result = await withConsoleLogsRoutedToStderrForJson(
      ["node", "openclaw", "agents", "add", ...(json ? ["--json"] : [])],
      () => requireValidConfigForWrite(runtime),
      { restoreChanges: true },
    );
    await Promise.resolve();
    expect(result).toBe(writeSnapshot);
    expect(result?.writeOptions.envSnapshotForRestore).toEqual({ CONFIG_READ_TOKEN: "at-read" });
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
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
});
