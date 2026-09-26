// Mutation-intent service reads preserve definitions that need safe migration.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import {
  readGatewayServiceCommandForMutation,
  readGatewayServiceState,
  type GatewayService,
  type GatewayServiceCommandConfig,
} from "./service.js";
import { createMockGatewayService } from "./service.test-helpers.js";

const readExistingLaunchAgentPlist = vi.hoisted(() => vi.fn());
const readRelocatedLaunchAgentForInstall = vi.hoisted(() => vi.fn());
const resolveLaunchAgentPlistPath = vi.hoisted(() => vi.fn(() => "/canonical/gateway.plist"));

vi.mock("./launchd-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launchd-install.js")>()),
  readRelocatedLaunchAgentForInstall,
}));

vi.mock("./launchd-service-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./launchd-service-files.js")>()),
  readExistingLaunchAgentPlist,
  resolveLaunchAgentPlistPath,
}));

function createService(command: GatewayServiceCommandConfig | null): GatewayService {
  return createMockGatewayService({ readCommand: vi.fn(async () => command) });
}

describe("readGatewayServiceCommandForMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessPlatform("darwin");
    readExistingLaunchAgentPlist.mockResolvedValue(null);
    readRelocatedLaunchAgentForInstall.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the canonical command without probing a relocated definition", async () => {
    const command = { programArguments: ["openclaw", "gateway", "run"] };

    await expect(
      readGatewayServiceCommandForMutation(createService(command), process.env),
    ).resolves.toEqual({ kind: "current", command });
    expect(readExistingLaunchAgentPlist).not.toHaveBeenCalled();
    expect(readRelocatedLaunchAgentForInstall).not.toHaveBeenCalled();
  });

  it("returns a verified relocated definition only when the canonical plist is absent", async () => {
    const command = {
      programArguments: ["node", "--max-old-space-size=4096", "openclaw", "gateway"],
      environment: { NODE_OPTIONS: "" },
    };
    readRelocatedLaunchAgentForInstall.mockResolvedValue({
      plistPath: "/external/Library/LaunchAgents/ai.openclaw.gateway.plist",
      command,
    });

    await expect(
      readGatewayServiceCommandForMutation(createService(null), process.env),
    ).resolves.toEqual({
      kind: "relocated",
      plistPath: "/external/Library/LaunchAgents/ai.openclaw.gateway.plist",
      command,
    });
    expect(readExistingLaunchAgentPlist).toHaveBeenCalledWith("/canonical/gateway.plist");
  });

  it("returns missing when neither canonical nor relocated definition exists", async () => {
    await expect(
      readGatewayServiceCommandForMutation(createService(null), process.env),
    ).resolves.toEqual({ kind: "missing", command: null });
  });

  it("fails closed when a canonical plist exists but cannot be parsed", async () => {
    readExistingLaunchAgentPlist.mockResolvedValue(Buffer.from("malformed"));

    await expect(
      readGatewayServiceCommandForMutation(createService(null), process.env),
    ).rejects.toThrow("cannot be safely inspected");
    expect(readRelocatedLaunchAgentForInstall).not.toHaveBeenCalled();
  });

  it("propagates canonical and relocated inspection errors", async () => {
    const canonicalError = new Error("canonical access denied");
    readExistingLaunchAgentPlist.mockRejectedValueOnce(canonicalError);
    await expect(
      readGatewayServiceCommandForMutation(createService(null), process.env),
    ).rejects.toBe(canonicalError);

    const relocatedError = new Error("relocated access denied");
    readExistingLaunchAgentPlist.mockResolvedValueOnce(null);
    readRelocatedLaunchAgentForInstall.mockRejectedValueOnce(relocatedError);
    await expect(
      readGatewayServiceCommandForMutation(createService(null), process.env),
    ).rejects.toBe(relocatedError);
  });

  it.each<[GatewayServiceCommandConfig | null, "current" | "missing"]>([
    [{ programArguments: ["openclaw", "gateway", "run"] }, "current"],
    [null, "missing"],
  ])("uses the steady-state command on non-Darwin platforms", async (command, kind) => {
    mockProcessPlatform("linux");

    await expect(
      readGatewayServiceCommandForMutation(createService(command), process.env),
    ).resolves.toEqual({ kind, command });
    expect(readExistingLaunchAgentPlist).not.toHaveBeenCalled();
    expect(readRelocatedLaunchAgentForInstall).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "linux", strict: false, kind: "ordinary" },
    { platform: "linux", strict: true, kind: "ordinary" },
    { platform: "linux", strict: false, kind: "ownership" },
    { platform: "darwin", strict: true, kind: "ownership" },
    { platform: "linux", strict: false, kind: "cleanup" },
    { platform: "darwin", strict: true, kind: "cleanup" },
  ] as const)(
    "preserves $kind command-read failure on $platform (strict=$strict)",
    async ({ platform, strict, kind }) => {
      mockProcessPlatform(platform);
      const error =
        kind === "cleanup"
          ? new CommandProcessCleanupError()
          : kind === "ownership"
            ? new ServiceOwnershipRefusalError("systemd-manager-changed")
            : new Error("command read failed");
      const service = createMockGatewayService({ readCommand: vi.fn().mockRejectedValue(error) });
      await expect(
        readGatewayServiceCommandForMutation(
          service,
          { HOME: "/fixture" },
          strict ? { requireEffective: true } : undefined,
        ),
      ).rejects.toBe(error);
      expect(readRelocatedLaunchAgentForInstall).not.toHaveBeenCalled();
    },
  );

  it("uses a relocated command for strict pre-mutation service state", async () => {
    const command = {
      programArguments: ["node", "openclaw", "gateway", "--port", "19876"],
      environment: { OPENCLAW_STATE_DIR: "/external/state" },
    };
    const service = createService(null);
    readRelocatedLaunchAgentForInstall.mockResolvedValue({
      plistPath: "/external/Library/LaunchAgents/ai.openclaw.gateway.plist",
      command,
    });

    await expect(
      readGatewayServiceState(service, {
        env: { HOME: "/external" },
        requireEffective: true,
      }),
    ).resolves.toMatchObject({
      installed: true,
      command,
      env: {
        HOME: "/external",
        OPENCLAW_STATE_DIR: "/external/state",
      },
    });
  });
});
