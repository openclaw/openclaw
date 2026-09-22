import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinRuntimePaths } from "../../config/paths.js";
import * as runtimeSnapshot from "../../config/runtime-snapshot.js";
import type { ConfigFileSnapshot } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
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

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: configReads.readSnapshot,
}));
vi.mock("../../config/io.factory.js", () => ({
  createConfigIO: () => ({ prepareConfigRecovery: configReads.prepareRecovery }),
}));

let state: OpenClawTestState;
const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
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

describe("dev reset admission for invalid config", () => {
  it.each([
    { name: "absent", source: {} },
    { name: "null", source: { sourceConfig: null } },
    { name: "non-object", source: { sourceConfig: "invalid" } },
  ])("admits recovery when sourceConfig is $name", async ({ source }) => {
    configReads.readSnapshot.mockResolvedValue(invalidSnapshot(source));

    // Reset bypasses mutation-capable bootstrap and keeps its own guarded admission.
    await expect(prepareGatewayRunBootstrap({ opts, runtime })).resolves.toBe(false);
    const hash = vi.spyOn(runtimeSnapshot, "hashRuntimeConfigValue");
    await expect(recheckGatewayRunReset({ opts, runtime })).resolves.toBe(true);
    expect(hash).not.toHaveBeenCalled();

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each(["raw contents", "file target"] as const)(
    "refuses recovery when the invalid config changes its %s",
    async (change) => {
      const snapshot = invalidSnapshot();
      configReads.readSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
        ...snapshot,
        ...(change === "raw contents"
          ? { raw: "{ a different invalid config" }
          : { path: state.statePath("other.json") }),
      });

      await expect(prepareGatewayRunBootstrap({ opts, runtime })).resolves.toBe(false);
      await expect(recheckGatewayRunReset({ opts, runtime })).resolves.toBe(false);

      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("selected config or state target changed during startup"),
      );
    },
  );
});
