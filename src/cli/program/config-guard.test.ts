import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAndMaybeMigrateDoctorConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: loadAndMaybeMigrateDoctorConfigMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

function makeSnapshot() {
  return {
    exists: false,
    valid: true,
    issues: [],
    legacyIssues: [],
    path: "/tmp/openclaw.json",
  };
}

function makeRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("ensureConfigReady", () => {
  async function loadEnsureConfigReady() {
    vi.resetModules();
    return await import("./config-guard.js");
  }

  async function runEnsureConfigReady(commandPath: string[]) {
    const runtime = makeRuntime();
    const { ensureConfigReady } = await loadEnsureConfigReady();
    await ensureConfigReady({ runtime: runtime as never, commandPath });
    return runtime;
  }

  function setInvalidSnapshot(overrides?: Partial<ReturnType<typeof makeSnapshot>>) {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...makeSnapshot(),
      exists: true,
      valid: false,
      issues: [{ path: "channels.whatsapp", message: "invalid" }],
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());
  });

  it.each([
    {
      name: "skips doctor flow for read-only fast path commands",
      commandPath: ["status"],
      expectedDoctorCalls: 0,
    },
    {
      name: "runs doctor flow for commands that may mutate state",
      commandPath: ["message"],
      expectedDoctorCalls: 1,
    },
  ])("$name", async ({ commandPath, expectedDoctorCalls }) => {
    await runEnsureConfigReady(commandPath);
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(expectedDoctorCalls);
  });

  it("exits for invalid config on non-allowlisted commands", async () => {
    setInvalidSnapshot();
    const runtime = await runEnsureConfigReady(["message"]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Config invalid"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("doctor --fix"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not exit for invalid config on allowlisted commands", async () => {
    setInvalidSnapshot();
    const statusRuntime = await runEnsureConfigReady(["status"]);
    expect(statusRuntime.exit).not.toHaveBeenCalled();

    const gatewayRuntime = await runEnsureConfigReady(["gateway", "health"]);
    expect(gatewayRuntime.exit).not.toHaveBeenCalled();
  });

  it("runs doctor migration flow only once per module instance", async () => {
    const runtimeA = makeRuntime();
    const runtimeB = makeRuntime();
    const { ensureConfigReady } = await loadEnsureConfigReady();

    await ensureConfigReady({ runtime: runtimeA as never, commandPath: ["message"] });
    await ensureConfigReady({ runtime: runtimeB as never, commandPath: ["message"] });

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });
});
