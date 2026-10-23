import { Command } from "commander";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "../../daemon/service-inspection-error.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { registerGatewayCli } from "../gateway-cli/register.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import {
  callGatewayStatusProbe,
  capturePrintedDaemonStatus,
} from "./status.gather.probes.test-support.js";

export function createStatusCommand() {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerGatewayCli(program);
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
    throw new Error("status-exit");
  });
  onTestFinished(() => {
    for (const spy of [writeJson, exit]) {
      spy.mockRestore();
    }
  });
  return { program, writeJson, exit };
}

export function registerServiceInspectionStatusTests(params: {
  serviceFixture: { useSystemdCommand: boolean };
  setCliConfig: (config: Record<string, unknown>) => void;
  isGatewayExternallySupervised: { mockReturnValue(value: boolean): unknown };
  findSystemdGatewayInstallation: { mockRejectedValueOnce(error: unknown): unknown };
  loadInstalledPluginIndexInstallRecords: {
    mockResolvedValueOnce(records: Record<string, unknown>): unknown;
  };
  serviceIsLoaded: {
    mockRejectedValueOnce(error: unknown): unknown;
  };
  serviceReadCommand: { mockResolvedValueOnce(command: null): unknown };
  serviceReadRuntime: {
    mockRejectedValueOnce(error: unknown): unknown;
  };
  inspectGatewayRestart: () => unknown;
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
}): void {
  const {
    serviceFixture,
    isGatewayExternallySupervised,
    findSystemdGatewayInstallation,
    loadInstalledPluginIndexInstallRecords,
    serviceIsLoaded,
    serviceReadCommand,
    serviceReadRuntime,
    inspectGatewayRestart,
    gatherStatus,
  } = params;

  it("keeps registered gateway status available after systemd discovery fails", async () => {
    serviceFixture.useSystemdCommand = true;
    isGatewayExternallySupervised.mockReturnValue(false);
    findSystemdGatewayInstallation.mockRejectedValueOnce(
      Object.assign(
        new Error("EACCES: permission denied, open '/etc/example-gateway/private.env'"),
        {
          code: "EACCES",
        },
      ),
    );
    params.setCliConfig({ gateway: { bind: "loopback", auth: { token: "caller-token" } } });
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce({
      whatsapp: {
        source: "npm",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.6",
      },
    });
    const { program, writeJson, exit } = createStatusCommand();
    await program.parseAsync(["gateway", "status", "--json"], { from: "user" });

    expect(exit).not.toHaveBeenCalled();
    expect(writeJson.mock.calls[0]?.[0]).toMatchObject({
      service: {
        loaded: null,
        loadState: { status: "unknown" },
        command: null,
        targetRole: "diagnostic-only",
        runtime: {
          status: "unknown",
          inspectionFailure: { code: "service-runtime-inspection-failed" },
        },
      },
      config: { daemon: { path: "/tmp/openclaw-cli/openclaw.json" } },
      pluginVersionDrift: { gatewayVersion: "2026.5.6", drifts: [] },
      rpc: { ok: true, server: { version: "2026.5.6", buildId: "build-2026.5.6" } },
    });
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain("systemdInstallation");
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain("private.env");
    expect(serviceIsLoaded).not.toHaveBeenCalled();
    expect(serviceReadRuntime).not.toHaveBeenCalled();
    expect(inspectGatewayRestart).not.toHaveBeenCalled();
    expect(callGatewayStatusProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "caller-token",
        configPath: "/tmp/openclaw-cli/openclaw.json",
      }),
    );
  });

  it.each(["systemd ownership", "command cleanup"] as const)(
    "keeps %s refusals fatal at the gateway status entrypoint",
    async (kind) => {
      if (kind === "systemd ownership") {
        serviceFixture.useSystemdCommand = true;
        findSystemdGatewayInstallation.mockRejectedValueOnce(
          new ServiceOwnershipRefusalError("systemd-manager-changed"),
        );
      } else {
        serviceReadRuntime.mockRejectedValueOnce(new CommandProcessCleanupError());
      }
      const { program, writeJson, exit } = createStatusCommand();
      await expect(
        program.parseAsync(["gateway", "status", "--json"], { from: "user" }),
      ).rejects.toThrow("status-exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(JSON.stringify(writeJson.mock.calls)).toContain(
        kind === "systemd ownership"
          ? "manager identity changed"
          : "Command cleanup could not confirm that owned work stopped",
      );
      expect(callGatewayStatusProbe).not.toHaveBeenCalled();
      expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    },
  );

  it.each([
    { platform: "linux", reason: "service-manager-unavailable", recorded: true },
    { platform: "linux", reason: "service-manager-unavailable", recorded: false },
    { platform: "darwin", reason: "launchd-gui-domain-unavailable", recorded: true },
  ] as const)(
    "reports $reason with recorded service=$recorded without inventing manager availability",
    async ({ platform, reason, recorded }) =>
      withMockedPlatform(platform, async () => {
        const inspectionError = new ServiceInspectionError(reason);
        serviceIsLoaded.mockRejectedValueOnce(inspectionError);
        serviceReadRuntime.mockRejectedValueOnce(inspectionError);
        if (!recorded) {
          serviceReadCommand.mockResolvedValueOnce(null);
        }
        const status = await gatherStatus({ probe: false, deep: true });
        expect(status.service.inspectionReason).toBe(reason);
        expect(status.service.loaded).toBeNull();
        const printed = capturePrintedDaemonStatus(status, { json: false, deep: true });
        const output = `${printed.logs}\n${printed.errors}`;
        if (reason === "service-manager-unavailable") {
          expect(output).toContain("Service: no supported service manager detected");
          expect(status.config?.daemon?.path).toBe(status.config?.cli.path);
          expect(status.gateway?.port).toBe(18789);
          expect(status.service.targetRole).toBe("diagnostic-only");
          expect(output.includes("recorded service unit is stale")).toBe(recorded);
          expect(output.includes("Recorded command:")).toBe(recorded);
          expect(output).toContain(
            "Manage the Gateway through the supervisor or terminal that started it.",
          );
          expect(output).not.toContain("Service: LaunchAgent (unknown)");
          expect(output).not.toContain("Retry: openclaw gateway status --deep");
        } else {
          expect(output).toContain("Service: LaunchAgent (unknown)");
          expect(output).not.toContain("no supported service manager detected");
        }
      }),
  );
}
