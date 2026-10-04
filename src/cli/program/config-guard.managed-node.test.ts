import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ExitError } from "../../runtime.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import { ensureConfigReady, testApi } from "./config-guard.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  prepareStartup: vi.fn(),
  setRuntimeConfig: vi.fn(),
  offerRecovery: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfig,
  setRuntimeConfigSnapshot: mocks.setRuntimeConfig,
}));
vi.mock("../../commands/startup-config-preflight.js", () => ({
  runStartupConfigPreflight: mocks.prepareStartup,
}));
vi.mock("../invalid-config-recovery.js", () => ({
  offerInvalidConfigRecovery: mocks.offerRecovery,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
let statePath: string;
const config = { plugins: { entries: { fixture: { enabled: true } } } };

function snapshot(valid = true) {
  return {
    path: path.join(path.dirname(path.dirname(statePath)), "openclaw.json"),
    exists: true,
    valid,
    raw: JSON.stringify(config),
    parsed: config,
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: valid
      ? []
      : [{ path: "plugins.entries.fixture.config", message: "invalid plugin value" }],
    warnings: [],
    legacyIssues: [],
  };
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new ExitError(code);
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  testApi.resetConfigGuardStateForTests();
  const stateDir = temporary.make("managed-node-config-guard-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_NIX_MODE", undefined);
  vi.stubEnv("OPENCLAW_CONFIG_READONLY", undefined);
  statePath = path.join(stateDir, "state", "openclaw.sqlite");
  mocks.readConfig.mockImplementation(async () => snapshot());
  mocks.prepareStartup.mockImplementation(async () => ({
    snapshot: snapshot(),
    baseConfig: config,
  }));
});

afterEach(() => vi.unstubAllEnvs());

describe("managed node startup config", () => {
  it.each([
    { commandPath: ["node", "run"], managed: true, valid: true },
    { commandPath: ["connect"], managed: true, valid: true },
    { commandPath: ["node", "run"], managed: false, valid: true },
    { commandPath: ["node", "run"], managed: true, valid: false },
  ])(
    "validates $commandPath with managed=$managed and valid=$valid",
    async ({ commandPath, managed, valid }) => {
      mocks.readConfig.mockResolvedValue(snapshot(valid));
      const host = runtime();
      const check = () => ensureConfigReady({ runtime: host, commandPath });
      if (!managed) {
        await check();
        expect(mocks.prepareStartup).toHaveBeenCalledWith({ gateway: false });
        return;
      }
      const result = withExistingOpenClawStateSchema({ path: statePath }, check);
      if (valid) {
        await result;
        expect(mocks.setRuntimeConfig).toHaveBeenCalledWith(config, config);
        expect(host.exit).not.toHaveBeenCalled();
      } else {
        await expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(mocks.offerRecovery).not.toHaveBeenCalled();
        expect(mocks.setRuntimeConfig).not.toHaveBeenCalled();
        expect(host.error.mock.calls.join("\n")).toContain("invalid plugin value");
      }
      expect(mocks.prepareStartup).not.toHaveBeenCalled();
      expect(mocks.readConfig).toHaveBeenCalledWith({ observe: false });
    },
  );

  it("rejects changed state selectors before config or migration work", async () => {
    const otherDir = temporary.make("other-managed-node-state-");
    await expect(
      withExistingOpenClawStateSchema({ path: statePath }, async () => {
        vi.stubEnv("OPENCLAW_STATE_DIR", otherDir);
        await ensureConfigReady({ runtime: runtime(), commandPath: ["node", "run"] });
      }),
    ).rejects.toThrow(/state.*(?:bound|changed)/i);

    expect(mocks.readConfig).not.toHaveBeenCalled();
    expect(mocks.prepareStartup).not.toHaveBeenCalled();
  });
});
