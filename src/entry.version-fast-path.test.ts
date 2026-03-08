import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const applyCliProfileEnvMock = vi.hoisted(() => vi.fn());
const attachChildProcessBridgeMock = vi.hoisted(() => vi.fn());
const installProcessWarningFilterMock = vi.hoisted(() => vi.fn());
const isMainModuleMock = vi.hoisted(() => vi.fn(() => true));
const isRootHelpInvocationMock = vi.hoisted(() => vi.fn(() => false));
const isRootVersionInvocationMock = vi.hoisted(() => vi.fn(() => true));
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const normalizeWindowsArgvMock = vi.hoisted(() => vi.fn((argv: string[]) => argv));
const parseCliProfileArgsMock = vi.hoisted(() => vi.fn((argv: string[]) => ({ ok: true, argv })));
const resolveCommitHashMock = vi.hoisted(() => vi.fn(() => "abc1234"));
const shouldSkipRespawnForArgvMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("./cli/argv.js", () => ({
  isRootHelpInvocation: isRootHelpInvocationMock,
  isRootVersionInvocation: isRootVersionInvocationMock,
}));

vi.mock("./cli/profile.js", () => ({
  applyCliProfileEnv: applyCliProfileEnvMock,
  parseCliProfileArgs: parseCliProfileArgsMock,
}));

vi.mock("./cli/respawn-policy.js", () => ({
  shouldSkipRespawnForArgv: shouldSkipRespawnForArgvMock,
}));

vi.mock("./cli/windows-argv.js", () => ({
  normalizeWindowsArgv: normalizeWindowsArgvMock,
}));

vi.mock("./infra/env.js", () => ({
  isTruthyEnvValue: () => false,
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("./infra/git-commit.js", () => ({
  resolveCommitHash: resolveCommitHashMock,
}));

vi.mock("./infra/is-main.js", () => ({
  isMainModule: isMainModuleMock,
}));

vi.mock("./infra/warning-filter.js", () => ({
  installProcessWarningFilter: installProcessWarningFilterMock,
}));

vi.mock("./process/child-process-bridge.js", () => ({
  attachChildProcessBridge: attachChildProcessBridgeMock,
}));

vi.mock("./version.js", () => ({
  VERSION: "9.9.9-test",
}));

describe("entry root version fast path", () => {
  let originalArgv: string[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalArgv = [...process.argv];
    process.argv = ["node", "openclaw", "--version"];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("prints commit-tagged version output when commit metadata is available", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./entry.js");

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith("OpenClaw 9.9.9-test (abc1234)");
    });

    logSpy.mockRestore();
  });

  it("falls back to plain version output when commit metadata is unavailable", async () => {
    resolveCommitHashMock.mockReturnValueOnce(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("./entry.js");

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith("OpenClaw 9.9.9-test");
    });

    logSpy.mockRestore();
  });
});
