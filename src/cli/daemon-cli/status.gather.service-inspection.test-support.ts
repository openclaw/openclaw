import { Command } from "commander";
import { expect, it, vi } from "vitest";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "../../daemon/service-inspection-error.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { VERSION } from "../../version.js";
import { registerGatewayCli } from "../gateway-cli/register.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import { callGatewayStatusProbe } from "./status.gather.probes.test-support.js";
import { printDaemonStatus } from "./status.print.js";

export function registerServiceInspectionStatusTests(params: {
  serviceFixture: { useSystemdCommand: boolean };
  setCliConfig: (config: Record<string, unknown>) => void;
  isGatewayExternallySupervised: { mockReturnValue(value: boolean): unknown };
  findSystemdGatewayInstallation: { mockRejectedValueOnce(error: unknown): unknown };
  loadInstalledPluginIndexInstallRecords: {
    mockResolvedValueOnce(records: Record<string, unknown>): unknown;
  };
  serviceIsLoaded: {
    mockResolvedValueOnce(loaded: boolean): unknown;
    mockRejectedValueOnce(error: unknown): unknown;
  };
  serviceReadCommand: { mockResolvedValueOnce(command: null): unknown };
  serviceReadRuntime: {
    mockResolvedValueOnce(runtime: GatewayServiceRuntime): unknown;
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

  it.each([false, true].flatMap((external) => [true, false].map((probe) => ({ external, probe }))))(
    "keeps registered gateway status available after systemd discovery fails (external=$external, probe=$probe)",
    async ({ external, probe }) => {
      serviceFixture.useSystemdCommand = true;
      isGatewayExternallySupervised.mockReturnValue(external);
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
          resolvedVersion: probe ? "2026.5.6" : VERSION,
        },
      });
      const program = new Command().enablePositionalOptions().exitOverride();
      registerGatewayCli(program);
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
        throw new Error("status-exit");
      });
      try {
        await program.parseAsync(
          ["gateway", "status", "--json", ...(probe ? [] : ["--no-probe"])],
          { from: "user" },
        );

        expect(exit).not.toHaveBeenCalled();
        expect(writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            service: expect.objectContaining({
              loaded: null,
              loadState: expect.objectContaining({ status: "unknown" }),
              command: null,
              targetRole: "diagnostic-only",
              runtime: expect.objectContaining({
                status: "unknown",
                inspectionFailure: expect.objectContaining({
                  code: "service-runtime-inspection-failed",
                }),
              }),
            }),
            config: expect.objectContaining({
              daemon: expect.objectContaining({ path: "/tmp/openclaw-cli/openclaw.json" }),
            }),
            pluginVersionDrift: expect.objectContaining({
              gatewayVersion: probe ? "2026.5.6" : VERSION,
              drifts: [],
            }),
          }),
        );
        expect(JSON.stringify(writeJson.mock.calls)).not.toContain("systemdInstallation");
        expect(JSON.stringify(writeJson.mock.calls)).not.toContain("private.env");
        expect(serviceIsLoaded).not.toHaveBeenCalled();
        expect(serviceReadRuntime).not.toHaveBeenCalled();
        expect(inspectGatewayRestart).not.toHaveBeenCalled();
        if (probe) {
          expect(callGatewayStatusProbe).toHaveBeenCalledWith(
            expect.objectContaining({
              url: "ws://127.0.0.1:18789",
              token: "caller-token",
              configPath: "/tmp/openclaw-cli/openclaw.json",
            }),
          );
          expect(writeJson).toHaveBeenCalledWith(
            expect.objectContaining({
              rpc: expect.objectContaining({
                ok: true,
                server: expect.objectContaining({
                  version: "2026.5.6",
                  buildId: "build-2026.5.6",
                }),
              }),
            }),
          );
        } else {
          expect(callGatewayStatusProbe).not.toHaveBeenCalled();
        }
      } finally {
        writeJson.mockRestore();
        exit.mockRestore();
      }
    },
  );

  it("keeps systemd ownership refusals fatal at the gateway status entrypoint", async () => {
    serviceFixture.useSystemdCommand = true;
    findSystemdGatewayInstallation.mockRejectedValueOnce(
      new ServiceOwnershipRefusalError("systemd-manager-changed"),
    );
    const program = new Command().enablePositionalOptions().exitOverride();
    registerGatewayCli(program);
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("status-exit");
    });
    try {
      await expect(
        program.parseAsync(["gateway", "status", "--json"], { from: "user" }),
      ).rejects.toThrow("status-exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(JSON.stringify(writeJson.mock.calls)).toContain("manager identity changed");
      expect(callGatewayStatusProbe).not.toHaveBeenCalled();
      expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    } finally {
      writeJson.mockRestore();
      exit.mockRestore();
    }
  });

  it("keeps gateway status read-only when service management is unsupported", async () => {
    serviceReadCommand.mockResolvedValueOnce(null);
    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceReadRuntime.mockResolvedValueOnce({
      status: "unknown",
      detail: "Gateway service install not supported on aix",
    });

    const status = await gatherStatus({ probe: false });

    expect(status.service.command).toBeNull();
    expect(status.service.loaded).toBe(false);
    expect(status.service.loadState).toEqual({ status: "not-loaded" });
    expect(status.service.runtime).toEqual({
      status: "unknown",
      detail: "Gateway service install not supported on aix",
    });
    expect(inspectGatewayRestart).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "linux", reason: "service-manager-unavailable", recorded: true },
    { platform: "linux", reason: "service-manager-unavailable", recorded: false },
    { platform: "linux", reason: "systemd-user-bus-unavailable", recorded: true },
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
        const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        try {
          printDaemonStatus(status, { json: false, deep: true });
          const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
          if (reason === "service-manager-unavailable") {
            expect(output).toContain("Service: no supported service manager detected");
            expect(status.config?.daemon?.path).toBe(status.config?.cli.path);
            expect(status.gateway?.port).toBe(18789);
            expect(status.service.targetRole).toBe("diagnostic-only");
            expect(output.includes("recorded service unit is stale")).toBe(recorded);
            expect(output.includes("Recorded command:")).toBe(recorded);
            expect(output).toContain("Restart the Gateway you launched manually");
            expect(output).not.toContain("Service: LaunchAgent (unknown)");
            expect(output).not.toContain("Retry: openclaw gateway status --deep");
          } else {
            expect(output).toContain("Service: LaunchAgent (unknown)");
            expect(output).not.toContain("no supported service manager detected");
          }
        } finally {
          log.mockRestore();
          error.mockRestore();
        }
      }),
  );
}
