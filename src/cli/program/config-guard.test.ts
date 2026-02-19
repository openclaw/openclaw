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
  async function runEnsureConfigReady(commandPath: string[]) {
    vi.resetModules();
    const { ensureConfigReady } = await import("./config-guard.js");
    await ensureConfigReady({ runtime: makeRuntime() as never, commandPath });
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
});
