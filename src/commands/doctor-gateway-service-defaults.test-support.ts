import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

type ServiceDefaultsTestContext = {
  mocks: {
    readCommand: Mock;
    buildGatewayInstallPlan: Mock;
    auditGatewayServiceConfig: Mock;
    resolveGatewayPort: Mock;
    install: Mock;
    stage: Mock;
    restart: Mock;
    note: Mock;
  };
  gatewayProgramArguments: string[];
  runRepair: (config: OpenClawConfig) => Promise<void>;
  mockProcessPlatform: (platform: NodeJS.Platform) => void;
  expectNoNoteContaining: (message: string, title: string) => void;
};

export function registerDoctorServiceDefaultsTests({
  mocks,
  gatewayProgramArguments,
  runRepair,
  mockProcessPlatform,
  expectNoNoteContaining,
}: ServiceDefaultsTestContext) {
  it.each([true, false])(
    "reports definition facts without creating repair work (command available: %s)",
    async (hasCommand) => {
      const command = { programArguments: gatewayProgramArguments, environment: {} };
      mocks.readCommand.mockResolvedValue(hasCommand ? command : null);
      mocks.buildGatewayInstallPlan.mockResolvedValue(command);
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: true,
        issues: [],
        definitionDrift: [
          {
            kind: "outdated",
            key: "Service.KillMode",
            current: null,
            expected: "mixed",
            message: "Service.KillMode: missing; installer expects mixed.",
          },
          {
            kind: "unknown-edit",
            key: "Service.ExecStartPre",
            reason: "Operator-authored directive",
            message: "Service.ExecStartPre: unknown edit; preserved.",
          },
        ],
        definitionDriftError: "Could not inspect a service drop-in.",
      });

      await runRepair({ gateway: {} });

      const output = mocks.note.mock.calls
        .filter(([, title]) => title === "Gateway service definition")
        .map(([message]) => String(message))
        .join("\n");
      expect(output).toContain("Service.KillMode: missing");
      expect(output).toContain("Service.ExecStartPre: unknown edit; preserved");
      expect(output).toContain("Could not inspect a service drop-in");
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
    },
  );

  it("repairs managed port drift even when an operator overrides the working directory", async () => {
    mockProcessPlatform("linux");
    mocks.resolveGatewayPort.mockReturnValue(18888);
    const managedDefinition = {
      programArguments: gatewayProgramArguments,
      workingDirectory: "/opt/managed-openclaw",
      environment: {},
    };
    mocks.readCommand.mockResolvedValue({
      ...managedDefinition,
      workingDirectory: "/opt/operator-openclaw",
      managedDefinition,
      managedOverrides: { launcher: "working-directory" },
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["/usr/bin/node", "/usr/local/bin/openclaw", "gateway", "--port", "18888"],
      workingDirectory: "/tmp",
      environment: {},
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-port-mismatch",
          message: "Gateway service port does not match current gateway config.",
          detail: "18789 -> 18888",
          level: "recommended",
        },
      ],
    });
    mocks.install.mockResolvedValue(undefined);

    await runRepair({ gateway: { port: 18888 } });

    expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPort: 18888 }),
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ programArguments: expect.arrayContaining(["18888"]) }),
    );
    expectNoNoteContaining("operator-owned systemd drop-in", "Gateway service config");
  });

  it("repairs a short systemd stop timeout through the managed service installer", async () => {
    mockProcessPlatform("linux");
    const command = { programArguments: gatewayProgramArguments, environment: {} };
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockResolvedValue(command);
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "systemd-stop-timeout",
          message:
            "TimeoutStopSec=330 or longer is required for the Gateway drain and final cleanup.",
          level: "recommended",
        },
      ],
    });

    await runRepair({ gateway: {} });

    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(command));
  });
}
