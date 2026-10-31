import { beforeEach, expect, it, vi } from "vitest";
import { withConsoleLogsRoutedToStderrForJson } from "../cli/json-output-mode.js";
import { requireValidConfig, requireValidConfigForWrite } from "./config-validation.js";
import * as fixture from "./test-runtime-config-helpers.js";

const reads = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

// mock-isolation: Validate synthetic config snapshots without reading operator config files.
vi.mock("../config/config.js", () => reads);

const writeSnapshot = {
  snapshot: fixture.baseConfigSnapshot,
  writeOptions: {
    expectedConfigPath: fixture.baseConfigSnapshot.path,
    envSnapshotForRestore: { CONFIG_READ_TOKEN: "at-read" },
  },
};
const runtime = fixture.createTestRuntime();
beforeEach(() => vi.clearAllMocks());

it("retains native write ownership after an await in JSON mode", async () => {
  reads.readConfigFileSnapshotForWrite.mockResolvedValue(writeSnapshot);
  const result = await withConsoleLogsRoutedToStderrForJson(
    ["node", "openclaw", "agents", "add", "--json"],
    () => requireValidConfigForWrite(runtime),
    { restoreChanges: true },
  );
  await Promise.resolve();
  expect(result).toBe(writeSnapshot);
  expect(result?.writeOptions.envSnapshotForRestore).toEqual({ CONFIG_READ_TOKEN: "at-read" });
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
});

it("forwards config read options", async () => {
  const options = { skipPluginValidation: true, observe: false };
  reads.readConfigFileSnapshot.mockResolvedValue(fixture.baseConfigSnapshot);
  expect(await requireValidConfig(runtime, options)).toBe(fixture.baseConfigSnapshot.config);
  expect(reads.readConfigFileSnapshot).toHaveBeenCalledWith(options);
});

it.each([
  [true, "Fix: openclaw doctor --fix"],
  [
    false,
    "Fix: This is a plugin packaging issue, not a local config problem.\nUpdate or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
  ],
] as const)("rejects invalid config (write: %s)", async (write, hint) => {
  const issues = write
    ? { issues: [{ path: "mode", message: "Invalid" }] }
    : fixture.createPluginPackagingConfigIssues();
  const snapshot = { ...fixture.baseConfigSnapshot, sourceConfig: {}, valid: false, ...issues };
  const read = write ? reads.readConfigFileSnapshotForWrite : reads.readConfigFileSnapshot;
  read.mockResolvedValue(write ? { ...writeSnapshot, snapshot } : snapshot);
  expect(await (write ? requireValidConfigForWrite : requireValidConfig)(runtime)).toBeNull();
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(issues.issues[0]!.message));
  const advice = runtime.error.mock.calls.filter(
    ([line]) => typeof line === "string" && line.startsWith("Fix:"),
  );
  expect(advice).toEqual([[hint]]);
});
