import { beforeEach, expect, it, vi } from "vitest";
import {
  applyResolvedCommandOutputMode,
  withConsoleLogsRoutedToStderrForJson,
} from "../cli/json-output-mode.js";
import { requireValidConfig, requireValidConfigFileSnapshot } from "./config-validation.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const read = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise JSON diagnostics against synthetic snapshots without config-store I/O.
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: read,
  readConfigFileSnapshotForWrite: vi.fn(),
}));

const configPath = "/synthetic/openclaw.json";
const invalidSnapshot = {
  ...baseConfigSnapshot,
  path: configPath,
  valid: false,
  issues: [
    { path: " ", message: "Invalid root", allowedValues: [] },
    { path: "mode", message: "Choose", allowedValues: ["local"], allowedValuesHiddenCount: 2 },
  ],
  warnings: [],
};
const runtime = () => ({
  ...createTestRuntime(),
  writeStdout: vi.fn(),
  writeJson: vi.fn<(value: unknown) => void>(),
});
async function withJsonOutput<T>(run: () => Promise<T>) {
  return withConsoleLogsRoutedToStderrForJson(
    ["node", "openclaw", "agents", "list", "--json"],
    async () => {
      applyResolvedCommandOutputMode(true);
      return await run();
    },
    { restoreChanges: true },
  );
}
const expectedFailure = {
  ok: false,
  error: { type: "cli_error", message: `OpenClaw config is invalid: ${configPath}` },
  repairHint: "Run `openclaw doctor --fix` to repair, then retry.",
  issues: [
    { path: "<root>", message: "Invalid root" },
    { path: "mode", message: "Choose", allowedValues: ["local"], allowedValuesHiddenCount: 2 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(invalidSnapshot);
});

it("writes one enriched JSON failure before exit and no human diagnostic", async () => {
  const rt = runtime();
  await expect(withJsonOutput(() => requireValidConfig(rt))).rejects.toMatchObject({
    name: "ExitError",
    code: 1,
  });
  expect(rt.writeJson).toHaveBeenCalledExactlyOnceWith(expectedFailure, 2);
  expect(rt.writeJson.mock.invocationCallOrder[0]).toBeLessThan(
    rt.exit.mock.invocationCallOrder[0] ?? 0,
  );
  expect(rt.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(rt.log).not.toHaveBeenCalled();
  expect(rt.error).not.toHaveBeenCalled();
});

it("returns valid config without writing any failure document", async () => {
  const snapshot = { ...invalidSnapshot, valid: true, config: { plugins: {} } };
  read.mockResolvedValue(snapshot);
  const rt = runtime();
  expect(await withJsonOutput(() => requireValidConfigFileSnapshot(rt))).toBe(snapshot);
  expect(rt.writeJson).not.toHaveBeenCalled();
  expect(rt.exit).not.toHaveBeenCalled();
});
