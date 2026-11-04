import { Command } from "commander";
import { expect, it, onTestFinished, vi } from "vitest";
import { isLaunchAgentLoaded } from "../../daemon/launchd-runtime.js";
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
  serviceIsLoaded: RejectOnce & {
    mockImplementationOnce(implementation: () => Promise<boolean>): unknown;
  };
  serviceReadCommand: {
    mockResolvedValueOnce(command: null | { programArguments: string[] }): unknown;
  };
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
    [125, "Could not print domain: 125: Domain does not support specified action"],
    [13, "Permission denied"],
  ] as const)(
    "reports GUI-session guidance when launchd inspection exits %i",
    async (code, stderr) => {
      await withMockedPlatform("darwin", async () => {
        const native = vi.spyOn(await import("../../daemon/exec-file.js"), "execFileUtf8");
        onTestFinished(() => native.mockRestore());
        native.mockResolvedValue({ code, termination: "exit", stdout: "", stderr });
        params.serviceIsLoaded.mockImplementationOnce(() => isLaunchAgentLoaded({ env: {} }));

        const status = await params.gatherStatus({ probe: false });
        expect(status.service).toMatchObject({
          inspectionReason: "launchd-gui-domain-unavailable",
          loaded: null,
        });
        const printed = capturePrintedDaemonStatus(status, { json: false });
        const output = `${printed.logs}\n${printed.errors}`;
        expect(output).toContain("may be missing or inaccessible");
        expect(output).toContain("launchctl print gui/$(id -u)");
        expect(output).toContain("If the domain is missing, log in to the macOS desktop");
        expect(output).toContain("SSH");
        expect(output).toContain("OPENCLAW_SERVICE_REPAIR_POLICY=external");
        expect(output).not.toContain("Manage its LaunchAgent from");
      });
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
      params.serviceReadCommand.mockResolvedValueOnce({
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
        const status = await params.gatherStatus();

        // The probe reports what the process loaded; the layout reports what a restart
        // would load. Only their divergence means a restart is required.
        expect(status.gateway?.buildId).toBe("build-2026.5.6");
        expect(status.gateway?.installedBuildId).toBe(onDisk);
        expect(status.gateway?.restartRequired).toBe(restart ? true : undefined);
      }),
  );

  it("omits a build comparison for a Gateway whose install this host cannot read", async () => {
    const status = await params.gatherStatus({ rpc: { url: "wss://remote.example:19443" } });

    expect(status.gateway?.buildId).toBe("build-2026.5.6");
    expect(status.gateway?.installedBuildId).toBeUndefined();
    expect(status.gateway?.restartRequired).toBeUndefined();
  });

  it("keeps the registered service's build out of a comparison it does not target", async () =>
    await withServiceBuild("build-on-disk", async () => {
      // --port selects a Gateway by port on this host; the registered service keeps running
      // its own install, so its build says nothing about what the selected process loaded.
      const status = await params.gatherStatus({ rpc: { port: "19002" } });

      expect(status.service.targetRole).toBe("diagnostic-only");
      expect(status.service.layout?.packageBuildId).toBe("build-on-disk");
      expect(status.gateway?.buildId).toBe("build-2026.5.6");
      expect(status.gateway?.installedBuildId).toBeUndefined();
      expect(status.gateway?.restartRequired).toBeUndefined();
    }));
}
