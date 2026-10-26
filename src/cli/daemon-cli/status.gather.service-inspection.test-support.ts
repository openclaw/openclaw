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
import { expectNoCalls } from "./lifecycle-assertions.test-support.js";
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
    writeJson.mockRestore();
    exit.mockRestore();
  });
  return { program, writeJson, exit };
}

type RejectOnce = { mockRejectedValueOnce(error: unknown): unknown };

export function registerServiceInspectionStatusTests(params: {
  serviceFixture: { useSystemdCommand: boolean };
  setDaemonConfig: (config: Record<string, unknown>) => void;
  resolveGatewayBindHost: {
    mockImplementationOnce(implementation: () => Promise<string>): unknown;
  };
  setCliConfig: (config: Record<string, unknown>) => void;
  isGatewayExternallySupervised: { mockReturnValue(value: boolean): unknown };
  findSystemdGatewayInstallation: RejectOnce;
  loadInstalledPluginIndexInstallRecords: () => unknown;
  serviceIsLoaded: RejectOnce;
  serviceReadCommand: { mockResolvedValueOnce(command: null): unknown };
  serviceReadRuntime: RejectOnce;
  inspectGatewayRestart: () => unknown;
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
}): void {
  it("uses fallback network details when interface discovery throws during status inspection", async () => {
    params.setDaemonConfig({ gateway: { bind: "tailnet", tls: { enabled: true } } });
    params.resolveGatewayBindHost.mockImplementationOnce(async () => {
      throw new Error("uv_interface_addresses failed");
    });

    const status = await params.gatherStatus();

    expect(status.gateway).toMatchObject({
      bindHost: "127.0.0.1",
      probeUrl: "wss://127.0.0.1:19001",
      probeNote:
        "Status is using fallback network details because interface discovery failed: uv_interface_addresses failed.",
    });
  });

  it("keeps registered gateway status available after systemd discovery fails", async () => {
    params.serviceFixture.useSystemdCommand = true;
    params.findSystemdGatewayInstallation.mockRejectedValueOnce(
      Object.assign(new Error("EACCES: private.env"), { code: "EACCES" }),
    );
    params.setCliConfig({ gateway: { bind: "loopback", auth: { token: "caller-token" } } });
    const { program, writeJson } = createStatusCommand();
    await program.parseAsync(["gateway", "status", "--json"], { from: "user" });

    expect(writeJson.mock.calls[0]?.[0]).toMatchObject({
      service: {
        loaded: null,
        command: null,
        targetRole: "diagnostic-only",
        runtime: { inspectionFailure: { code: "service-runtime-inspection-failed" } },
      },
      rpc: { ok: true },
    });
    expect(JSON.stringify(writeJson.mock.calls)).not.toMatch(/systemdInstallation|private\.env/);
    const probe = callGatewayStatusProbe.mock.calls[0]?.[0];
    expect(probe).toMatchObject({
      url: "ws://127.0.0.1:18789",
      token: "caller-token",
      configPath: "/tmp/openclaw-cli/openclaw.json",
    });
  });

  it.each(["systemd ownership", "command cleanup"] as const)(
    "keeps %s refusals fatal at the gateway status entrypoint",
    async (kind) => {
      if (kind === "systemd ownership") {
        params.serviceFixture.useSystemdCommand = true;
        params.findSystemdGatewayInstallation.mockRejectedValueOnce(
          new ServiceOwnershipRefusalError("systemd-manager-changed"),
        );
      } else {
        params.serviceReadRuntime.mockRejectedValueOnce(new CommandProcessCleanupError());
      }
      const { program, writeJson, exit } = createStatusCommand();
      await expect(
        program.parseAsync(["gateway", "status", "--json"], { from: "user" }),
      ).rejects.toThrow("status-exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(writeJson).toHaveBeenCalled();
      expectNoCalls(callGatewayStatusProbe, params.loadInstalledPluginIndexInstallRecords);
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
        params.serviceIsLoaded.mockRejectedValueOnce(inspectionError);
        params.serviceReadRuntime.mockRejectedValueOnce(inspectionError);
        if (!recorded) {
          params.serviceReadCommand.mockResolvedValueOnce(null);
        }
        const status = await params.gatherStatus({ probe: false, deep: true });
        expect(status.service).toMatchObject({ inspectionReason: reason, loaded: null });
        const printed = capturePrintedDaemonStatus(status, { json: false, deep: true });
        const output = `${printed.logs}\n${printed.errors}`;
        expect(output.includes("Service: no supported service manager detected")).toBe(
          platform === "linux",
        );
        expect(output.includes("Service: LaunchAgent (unknown)")).toBe(platform === "darwin");
        if (reason === "service-manager-unavailable") {
          expect(status.config?.daemon?.path).toBe(status.config?.cli.path);
          expect(status.gateway?.port).toBe(18789);
          expect(status.service.targetRole).toBe("diagnostic-only");
          expect(output.includes("recorded service unit is stale")).toBe(recorded);
          expect(output.includes("Recorded command:")).toBe(recorded);
          expect(output).toContain(
            "Manage the Gateway through the supervisor or terminal that started it.",
          );
          expect(output).not.toContain("Retry: openclaw gateway status --deep");
        }
      }),
  );
}
