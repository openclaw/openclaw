// External-supervisor and container boundaries share the daemon-flow fixture.
import { expect, it, type Mock } from "vitest";
import type { SupervisorDisplayGuidance } from "../plugins/supervisor-guidance.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setPlatform } from "./doctor-gateway-daemon-flow.test-support.js";
import { formatServiceRepairDeferredNote } from "./doctor-service-repair-policy.js";

export function registerDoctorExternalSupervisorTests({
  resolveSupervisorGuidance,
  runNonInteractiveRepair,
  note,
  service,
  isContainerEnvironment,
  inspectPortUsage,
  findInstalledSystemdGatewayScope,
  findSystemGatewayServices,
}: {
  resolveSupervisorGuidance: Mock<() => Promise<SupervisorDisplayGuidance | undefined>>;
  runNonInteractiveRepair: () => Promise<void>;
  note: unknown;
  service: {
    isLoaded: unknown;
    readRuntime: unknown;
    readCommand: unknown;
    install: unknown;
    restart: unknown;
  };
  isContainerEnvironment: Mock<() => boolean>;
  inspectPortUsage: Mock;
  findInstalledSystemdGatewayScope: unknown;
  findSystemGatewayServices: unknown;
}) {
  it("shows deployment repair guidance without touching native services", async () => {
    resolveSupervisorGuidance.mockResolvedValue({
      version: 1,
      action: "repair",
      name: "Example host",
      command: "examplectl repair",
    });
    await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, runNonInteractiveRepair);
    expect(note).toHaveBeenCalledWith(expect.stringContaining("examplectl repair"), "Gateway");
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it.each([
    { environment: "container without an OpenClaw service", detected: true },
    { environment: "Kubernetes pod without container markers", kubernetes: true },
    { environment: "globally external supervisor", external: true },
  ])(
    "keeps port diagnostics but never probes host services in a $environment",
    async (scenario) => {
      setPlatform("linux");
      isContainerEnvironment.mockReturnValue(scenario.detected === true);
      inspectPortUsage.mockResolvedValueOnce({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 1234, command: "other-process" }],
        hints: [],
      });

      await withEnvAsync(
        {
          KUBERNETES_SERVICE_HOST: scenario.kubernetes ? "10.96.0.1" : undefined,
          KUBERNETES_SERVICE_PORT: scenario.kubernetes ? "443" : undefined,
          OPENCLAW_SUPERVISOR_MODE: scenario.external ? "external" : undefined,
        },
        runNonInteractiveRepair,
      );

      expect(inspectPortUsage).toHaveBeenCalledOnce();
      expect(note).toHaveBeenCalledWith("Port 18789 is already in use.", "Gateway port");
      expect(note).toHaveBeenCalledWith(formatServiceRepairDeferredNote("external"), "Gateway");
      expect(findInstalledSystemdGatewayScope).toHaveBeenCalledTimes(scenario.detected ? 1 : 0);
      expect(service.isLoaded).not.toHaveBeenCalled();
      expect(service.readRuntime).not.toHaveBeenCalled();
      expect(service.readCommand).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(findSystemGatewayServices).not.toHaveBeenCalled();
    },
  );
}
