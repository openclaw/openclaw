import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  probeGateway: vi.fn(),
  readServiceCommand: vi.fn(),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.callGateway,
}));
vi.mock("../gateway/probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/probe.js")>()),
  probeGateway: mocks.probeGateway,
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

import { checkCliGatewayStateDir, compareCliGatewayStateDirs } from "./state-dir-gateway-check.js";

describe("state-dir-gateway-check", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  let cliStateDir: string;
  let cliConfigPath: string;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-state-dir-check-");
    cliStateDir = path.join(root, "cli");
    cliConfigPath = path.join(cliStateDir, "openclaw.json");
    await fs.mkdir(cliStateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", cliStateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", cliConfigPath);
    mocks.callGateway.mockReset().mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.probeGateway.mockReset().mockResolvedValue({ ok: false });
    mocks.resolveGatewayService
      .mockReset()
      .mockReturnValue({ readCommand: mocks.readServiceCommand });
    mocks.readServiceCommand.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses canonical path identity for a missing config below a symlink", async () => {
    const gatewayStateDir = path.join(root, "gateway");
    const gatewayConfigPath = path.join(gatewayStateDir, "openclaw.json");
    await fs.mkdir(gatewayStateDir);
    const stateLink = path.join(root, "gateway-link");
    await fs.symlink(gatewayStateDir, stateLink);

    expect(
      compareCliGatewayStateDirs({
        cliStateDir: stateLink,
        cliConfigPath: path.join(stateLink, "openclaw.json"),
        gatewayStateDir,
        gatewayConfigPath,
        source: "live Gateway",
        mode: "refuse",
        command: "openclaw configure",
      }),
    ).toEqual({ kind: "allow" });
  });

  it("refuses an offline home mismatch using the recorded service environment", async () => {
    const canonicalRoot = await fs.realpath(root);
    const serviceHome = path.join(canonicalRoot, "service-home");
    const cliHome = path.join(canonicalRoot, "cli-home");
    const serviceRuntimeHome = path.join(serviceHome, "runtime");
    await fs.mkdir(serviceHome);
    await fs.mkdir(cliHome);
    vi.stubEnv("HOME", serviceHome);
    vi.stubEnv("OPENCLAW_HOME", cliHome);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    mocks.readServiceCommand.mockResolvedValue({
      programArguments: ["node", "gateway.js"],
      environment: {
        HOME: serviceHome,
        OPENCLAW_HOME: serviceRuntimeHome,
      },
    });

    await expect(
      checkCliGatewayStateDir({ command: "openclaw configure", config: {} }),
    ).resolves.toMatchObject({
      kind: "refuse",
      message: expect.stringContaining(path.join(serviceRuntimeHome, ".openclaw")),
    });
    const inspectedEnv = mocks.readServiceCommand.mock.calls[0]?.[0];
    expect(inspectedEnv).not.toHaveProperty("OPENCLAW_HOME");
    expect(mocks.readServiceCommand.mock.calls[0]?.[1]).toMatchObject({ requireEffective: true });
  });

  it("allows an offline command and does not probe an ordinary transport failure", async () => {
    await expect(
      checkCliGatewayStateDir({ command: "openclaw configure", config: {} }),
    ).resolves.toEqual({ kind: "allow" });
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

  it("warns when service inspection is unavailable without exposing its error", async () => {
    const error = new Error("private-service-inspection-canary");
    mocks.readServiceCommand.mockRejectedValue(error);

    const result = await checkCliGatewayStateDir({ command: "openclaw configure", config: {} });
    expect(result).toMatchObject({
      kind: "warn",
      message: expect.stringContaining("could not be verified"),
    });
    expect(JSON.stringify(result)).not.toContain("private-service-inspection-canary");
  });

  it("does not infer service paths from the CLI environment", async () => {
    mocks.readServiceCommand.mockResolvedValue({
      programArguments: ["node", "gateway.js"],
      environment: { PATH: "/synthetic/bin" },
    });

    await expect(
      checkCliGatewayStateDir({ command: "openclaw configure", config: {} }),
    ).resolves.toMatchObject({ kind: "warn" });
  });

  it("redacts credentials in remote target warnings", async () => {
    const result = await checkCliGatewayStateDir({
      command: "openclaw configure",
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://private-url-user:private-url-password@gateway.example?token=private-url-token",
          },
        },
      },
    });
    expect(result.kind).toBe("warn");
    expect(JSON.stringify(result)).not.toContain("private-url-");
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.readServiceCommand).not.toHaveBeenCalled();
  });
});
