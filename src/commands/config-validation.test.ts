import { beforeEach, expect, it, vi } from "vitest";
import { withConsoleLogsRoutedToStderrForJson } from "../cli/json-output-mode.js";
import { requireValidConfig, requireValidConfigForWrite } from "./config-validation.js";
import {
  baseConfigSnapshot,
  createPluginPackagingConfigIssues,
  createTestRuntime,
} from "./test-runtime-config-helpers.js";

const { readConfigFileSnapshot, readConfigFileSnapshotForWrite } = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
}));

const writeSnapshot = {
  snapshot: { ...baseConfigSnapshot, sourceConfig: {} },
  writeOptions: {
    expectedConfigPath: baseConfigSnapshot.path,
    envSnapshotForRestore: { CONFIG_READ_TOKEN: "at-read" },
    includeFileHashesForWrite: { "/tmp/include.json": "read-hash" },
  },
};
beforeEach(() => vi.clearAllMocks());

it("retains native write ownership after an await in JSON mode", async () => {
  readConfigFileSnapshotForWrite.mockResolvedValue(writeSnapshot);
  const runtime = createTestRuntime();
  const result = await withConsoleLogsRoutedToStderrForJson(
    ["node", "openclaw", "agents", "add", "--json"],
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
    ...writeSnapshot,
    snapshot: {
      ...writeSnapshot.snapshot,
      valid: false,
      issues: [{ path: "gateway.mode", message: "Invalid mode" }],
    },
  });
  const runtime = createTestRuntime();
  expect(await requireValidConfigForWrite(runtime)).toBeNull();
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expect(runtime.error).toHaveBeenCalledWith("Fix: openclaw doctor --fix");
});

it.each([{ skipPluginValidation: true }, { observe: false }])(
  "forwards config read options %j",
  async (options) => {
    readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot, config: { plugins: {} } });
    const runtime = createTestRuntime();

    await expect(requireValidConfig(runtime, options)).resolves.toEqual({ plugins: {} });

    expect(readConfigFileSnapshot).toHaveBeenCalledWith(options);
  },
);

it("replaces doctor fix advice for plugin packaging compiled-output failures", async () => {
  readConfigFileSnapshot.mockResolvedValue({
    ...baseConfigSnapshot,
    valid: false,
    sourceConfig: {},
    ...createPluginPackagingConfigIssues(),
  });
  const runtime = createTestRuntime();

  expect(await requireValidConfig(runtime)).toBeNull();
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("plugin not found"));
  expect(runtime.error).toHaveBeenCalledWith(
    "Fix: This is a plugin packaging issue, not a local config problem.\nUpdate or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
  );
  expect(runtime.error).not.toHaveBeenCalledWith("Fix: openclaw doctor --fix");
  expect(runtime.exit).toHaveBeenCalledWith(1);
});
