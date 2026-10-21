import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pinRuntimePaths } from "../../config/paths.js";
import * as runtimeSnapshot from "../../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { pinConfigDir } from "../../utils.js";
import {
  clearGatewayRunConfigEnvironment,
  prepareGatewayRunBootstrap,
  recheckGatewayRunReset,
} from "./pre-bootstrap.js";

type InvalidSnapshot = Omit<ConfigFileSnapshot, "sourceConfig"> & { sourceConfig?: null | string };

const configReads = vi.hoisted(() => ({
  readSnapshot: vi.fn<() => Promise<InvalidSnapshot>>(),
  prepareRecovery: vi.fn(async () => null),
}));

// mock-isolation: Reset admission consumes authored invalid snapshots without filesystem recovery.
vi.mock("../../config/io.factory.js", () => ({
  createConfigIO: () => ({
    readConfigFileSnapshot: configReads.readSnapshot,
    prepareConfigRecovery: configReads.prepareRecovery,
  }),
}));

let state: OpenClawTestState;
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const opts = { dev: true, reset: true, allowUnconfigured: true };

function invalidSnapshot(source: { sourceConfig?: null | string } = {}): InvalidSnapshot {
  return {
    path: state.configPath,
    exists: true,
    raw: "{ invalid config",
    parsed: null,
    resolved: {},
    runtimeConfig: {},
    config: {},
    valid: false,
    issues: [{ path: "<root>", message: "JSON parse failed" }],
    warnings: [],
    legacyIssues: [],
    ...source,
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "gateway-reset-invalid-config",
    env: { OPENCLAW_SERVICE_MARKER: undefined, OPENCLAW_PROFILE: "dev" },
  });
  pinRuntimePaths();
  pinConfigDir();
  configReads.readSnapshot.mockReset();
  configReads.prepareRecovery.mockClear();
  vi.mocked(runtime.error).mockClear();
  vi.mocked(runtime.exit).mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearGatewayRunConfigEnvironment();
  await state.cleanup();
  pinRuntimePaths();
  pinConfigDir();
});

it.each<[string, { sourceConfig?: null | string }, "raw" | "path" | null]>([
  ["absent", {}, null],
  ["null", { sourceConfig: null }, null],
  ["non-object", { sourceConfig: "invalid" }, null],
  ["raw contents", {}, "raw"],
  ["file target", {}, "path"],
])("guards invalid-config dev reset: %s", async (_name, source, change) => {
  const snapshot = invalidSnapshot(source);
  const current = { ...snapshot };
  if (change === "raw") {
    current.raw = "{ a different invalid config";
  }
  if (change === "path") {
    current.path = state.statePath("other.json");
  }
  configReads.readSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValue(current);
  await expect(prepareGatewayRunBootstrap({ opts, runtime })).resolves.toBe(false);
  const hash = vi.spyOn(runtimeSnapshot, "hashRuntimeConfigValue");
  await expect(recheckGatewayRunReset({ opts, runtime })).resolves.toBe(change === null);
  if (change) {
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("selected config or state target changed during startup"),
    );
  } else {
    expect(hash).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  }
});
