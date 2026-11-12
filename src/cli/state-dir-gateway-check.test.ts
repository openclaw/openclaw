import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  probeGateway: vi.fn(),
  readServiceCommand: vi.fn(),
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.callGateway,
}));
vi.mock("../gateway/probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/probe.js")>()),
  probeGateway: mocks.probeGateway,
}));
// mock-isolation: Compare fixture service commands without inspecting the host service manager.
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: mocks.readServiceCommand }),
}));

import { checkCliGatewayStateDir, compareCliGatewayStateDirs } from "./state-dir-gateway-check.js";

describe("state-dir-gateway-check", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  const check = (config: Parameters<typeof checkCliGatewayStateDir>[0]["config"] = {}) =>
    checkCliGatewayStateDir({ command: "openclaw configure", config });
  const serviceEnv = (environment: NodeJS.ProcessEnv) =>
    mocks.readServiceCommand.mockResolvedValue({ environment });

  beforeEach(async () => {
    root = tempDirs.make("openclaw-state-dir-check-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    mocks.callGateway.mockReset().mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.probeGateway.mockReset().mockResolvedValue({ ok: false });
    mocks.readServiceCommand.mockReset().mockResolvedValue(null);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses canonical path identity for a missing config below a symlink", async () => {
    const stateLink = path.join(root, "gateway-link");
    await fs.symlink(root, stateLink);

    expect(
      compareCliGatewayStateDirs({
        cliStateDir: stateLink,
        cliConfigPath: path.join(stateLink, "openclaw.json"),
        gatewayStateDir: root,
        source: "live Gateway",
        mode: "refuse",
      }),
    ).toEqual({ kind: "allow" });
  });

  it.skipIf(process.platform !== "win32")(
    "treats state and config paths that differ only by case as the same directory",
    () => {
      const lowerStateDir = path.join(root, ".openclaw");
      const upperStateDir = path.join(root, ".OPENCLAW");
      expect(
        compareCliGatewayStateDirs({
          cliStateDir: lowerStateDir,
          cliConfigPath: path.join(lowerStateDir, "openclaw.json"),
          gatewayStateDir: upperStateDir,
          gatewayConfigPath: path.join(upperStateDir, "openclaw.json"),
          source: "installed Gateway service",
          mode: "refuse",
        }),
      ).toEqual({ kind: "allow" });
    },
  );

  it("refuses an offline home mismatch using the recorded service environment", async () => {
    const canonicalRoot = await fs.realpath(root);
    const serviceHome = path.join(canonicalRoot, "service-home");
    const cliHome = path.join(canonicalRoot, "cli-home");
    const serviceRuntimeHome = path.join(serviceHome, "runtime");
    vi.stubEnv("HOME", serviceHome);
    vi.stubEnv("OPENCLAW_HOME", cliHome);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    serviceEnv({ HOME: serviceHome, OPENCLAW_HOME: serviceRuntimeHome });

    await expect(check()).resolves.toMatchObject({
      kind: "refuse",
      message: expect.stringContaining(path.join(serviceRuntimeHome, ".openclaw")),
    });
    const inspectedEnv = mocks.readServiceCommand.mock.calls[0]?.[0];
    expect(inspectedEnv).not.toHaveProperty("OPENCLAW_HOME");
    expect(mocks.readServiceCommand.mock.calls[0]?.[1]).toMatchObject({ requireEffective: true });
  });

  it("allows an offline command and does not probe an ordinary transport failure", async () => {
    await expect(check()).resolves.toEqual({ kind: "allow" });
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

  it.each(["error", "missing home"])(
    "warns without inferring paths or exposing %s",
    async (failure) => {
      if (failure === "error") {
        mocks.readServiceCommand.mockRejectedValue(new Error("private-service-inspection-canary"));
      } else {
        serviceEnv({ PATH: "/synthetic/bin" });
      }
      const result = await check();
      expect(result).toMatchObject({
        kind: "warn",
        message: expect.stringContaining("could not be verified"),
      });
      expect(JSON.stringify(result)).not.toContain("private-service-inspection-canary");
    },
  );

  it("redacts credentials in remote target warnings", async () => {
    const url =
      "wss://private-url-user:private-url-password@gateway.example?token=private-url-token";
    const result = await check({ gateway: { mode: "remote", remote: { url } } });
    expect(result.kind).toBe("warn");
    expect(JSON.stringify(result)).not.toContain("private-url-");
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.readServiceCommand).not.toHaveBeenCalled();
  });
});
