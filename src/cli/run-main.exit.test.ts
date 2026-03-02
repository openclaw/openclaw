import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("../infra/dotenv.js", () => ({
  loadDotEnv: loadDotEnvMock,
}));

vi.mock("../infra/env.js", () => ({
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: ensurePathMock,
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: assertRuntimeMock,
}));

const { runCli } = await import("./run-main.js");

describe("runCli exit behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "openclaw", "status"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("applies --profile env before dotenv loading in direct runCli calls", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const previousProfile = process.env.OPENCLAW_PROFILE;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
    delete process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_GATEWAY_PORT;

    try {
      await runCli(["node", "openclaw", "--profile", "rawdog", "status"]);

      expect(process.env.OPENCLAW_PROFILE).toBe("rawdog");
      expect(process.env.OPENCLAW_STATE_DIR).toContain(".openclaw-rawdog");
      expect(process.env.OPENCLAW_CONFIG_PATH).toContain(".openclaw-rawdog");
      expect(loadDotEnvMock).toHaveBeenCalledWith({ quiet: true });
      expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    } finally {
      if (previousProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = previousProfile;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousGatewayPort === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PORT;
      } else {
        process.env.OPENCLAW_GATEWAY_PORT = previousGatewayPort;
      }
    }
  });

  it("warns on invalid profile flags in direct runCli calls", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const argv = ["node", "openclaw", "--dev", "--profile", "rawdog", "status"];
      await runCli(argv);

      expect(warnSpy).toHaveBeenCalledWith("[openclaw] Cannot combine --dev with --profile");
      expect(tryRouteCliMock).toHaveBeenCalledWith(argv);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
