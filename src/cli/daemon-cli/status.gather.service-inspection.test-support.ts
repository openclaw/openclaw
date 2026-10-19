import { Command } from "commander";
import { expect, it, vi } from "vitest";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "../../daemon/service-inspection-error.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type {
  GatewayServiceEnvArgs,
  GatewayServiceReadOptions,
} from "../../daemon/service-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
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
    mockImplementationOnce(
      implementation: (args?: GatewayServiceEnvArgs) => Promise<boolean>,
    ): unknown;
    mockResolvedValueOnce(loaded: boolean): unknown;
    mockRejectedValueOnce(error: unknown): unknown;
  };
  serviceReadCommand: {
    mockResolvedValueOnce(command: null | { programArguments: string[] }): unknown;
  };
  serviceReadRuntime: {
    mockImplementationOnce(
      implementation: (
        env?: NodeJS.ProcessEnv,
        opts?: GatewayServiceReadOptions,
      ) => Promise<GatewayServiceRuntime>,
    ): unknown;
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
    const program = new Command().enablePositionalOptions().exitOverride();
    registerGatewayCli(program);
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("status-exit");
    });
    try {
      await program.parseAsync(["gateway", "status", "--json"], { from: "user" });

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
            gatewayVersion: "2026.5.6",
            drifts: [],
          }),
        }),
      );
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
    } finally {
      writeJson.mockRestore();
      exit.mockRestore();
    }
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
        expect(JSON.stringify(writeJson.mock.calls)).toContain(
          kind === "systemd ownership"
            ? "manager identity changed"
            : "Command cleanup could not confirm that owned work stopped",
        );
        expect(callGatewayStatusProbe).not.toHaveBeenCalled();
        expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      } finally {
        writeJson.mockRestore();
        exit.mockRestore();
      }
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
            expect(output).toContain(
              "Manage the Gateway through the supervisor or terminal that started it.",
            );
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

  /** Builds an install tree carrying `onDisk` in its own dist/build-info.json, registers it
   * as the service's command, and removes it once `run` returns. The node builtins are
   * imported here rather than at module scope because only these scenarios need them. */
  async function withServiceBuild(onDisk: string, run: () => Promise<void>): Promise<void> {
    const [fs, os, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ]);
    const installRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-status-build-id-")),
    );
    try {
      await fs.mkdir(path.join(installRoot, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(installRoot, "package.json"),
        '{"name":"openclaw","version":"2026.5.6"}',
      );
      await fs.writeFile(path.join(installRoot, "dist", "index.js"), "gateway");
      await fs.writeFile(
        path.join(installRoot, "dist", "build-info.json"),
        JSON.stringify({ version: "2026.5.6", buildId: onDisk }),
      );
      serviceReadCommand.mockResolvedValueOnce({
        programArguments: [
          "/bin/node",
          path.join(installRoot, "dist", "index.js"),
          "gateway",
          "--port",
          "19001",
        ],
      });
      await run();
    } finally {
      await fs.rm(installRoot, { recursive: true, force: true });
    }
  }

  it.each([
    { label: "rebuilt under the running Gateway", onDisk: "build-on-disk", restart: true },
    { label: "matching the loaded build", onDisk: "build-2026.5.6", restart: false },
  ])(
    "compares the loaded build id against the one on disk ($label)",
    async ({ onDisk, restart }) =>
      await withServiceBuild(onDisk, async () => {
        const status = await gatherStatus();

        // The probe reports what the process loaded; the layout reports what a restart
        // would load. Only their divergence means a restart is required.
        expect(status.gateway?.buildId).toBe("build-2026.5.6");
        expect(status.gateway?.installedBuildId).toBe(onDisk);
        expect(status.gateway?.restartRequired).toBe(restart ? true : undefined);
      }),
  );

  it("omits a build comparison for a Gateway whose install this host cannot read", async () => {
    const status = await gatherStatus({ rpc: { url: "wss://remote.example:19443" } });

    expect(status.gateway?.buildId).toBe("build-2026.5.6");
    expect(status.gateway?.installedBuildId).toBeUndefined();
    expect(status.gateway?.restartRequired).toBeUndefined();
  });

  it("keeps the registered service's build out of a comparison it does not target", async () =>
    await withServiceBuild("build-on-disk", async () => {
      // --port selects a Gateway by port on this host; the registered service keeps running
      // its own install, so its build says nothing about what the selected process loaded.
      const status = await gatherStatus({ rpc: { port: "19002" } });

      expect(status.service.targetRole).toBe("diagnostic-only");
      expect(status.service.layout?.packageBuildId).toBe("build-on-disk");
      expect(status.gateway?.buildId).toBe("build-2026.5.6");
      expect(status.gateway?.installedBuildId).toBeUndefined();
      expect(status.gateway?.restartRequired).toBeUndefined();
    }));
}
