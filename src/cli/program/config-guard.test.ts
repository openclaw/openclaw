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
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());
  });

  it("skips doctor flow for read-only fast path commands", async () => {
    vi.resetModules();
    const { ensureConfigReady } = await import("./config-guard.js");
    await ensureConfigReady({ runtime: makeRuntime() as never, commandPath: ["status"] });
    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("runs doctor flow for commands that may mutate state", async () => {
    vi.resetModules();
    const { ensureConfigReady } = await import("./config-guard.js");
    await ensureConfigReady({ runtime: makeRuntime() as never, commandPath: ["message"] });
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });
});
