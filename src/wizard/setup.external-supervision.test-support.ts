// Deployment guidance uses the same wizard fixture as ordinary onboarding.
import { expect, it, type Mock } from "vitest";
import type { SupervisorDisplayGuidance } from "../plugins/supervisor-guidance.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import type {
  ensureGatewayServiceForOnboarding as EnsureGatewayService,
  finalizeSetupWizard as FinalizeSetup,
} from "./setup.finalize.js";
import {
  expectNoteContains,
  expectNoteNotContains,
  withPlatform,
} from "./setup.finalize.test-support.js";

type FinalizeArgs = Parameters<typeof FinalizeSetup>[0];
export function registerWizardExternalSupervisorTests({
  resolveSupervisorGuidance,
  isSystemdUserServiceAvailable,
  isContainerEnvironment,
  createLaterPrompter,
  ensureGatewayServiceForOnboarding,
  createRuntime,
  gatewayServiceInstall,
  waitForGatewayReachable,
  probeGatewayReachable,
  finalizeSetupWizard,
  createFinalizeArgs,
  startGatewayServer,
}: {
  resolveSupervisorGuidance: Mock<() => Promise<SupervisorDisplayGuidance | undefined>>;
  isSystemdUserServiceAvailable: Mock<() => Promise<boolean>>;
  isContainerEnvironment: Mock<() => boolean>;
  createLaterPrompter: () => FinalizeArgs["prompter"];
  ensureGatewayServiceForOnboarding: typeof EnsureGatewayService;
  createRuntime: () => RuntimeEnv;
  gatewayServiceInstall: unknown;
  waitForGatewayReachable: Mock<() => Promise<{ ok: boolean; detail?: string }>>;
  probeGatewayReachable: Mock<() => Promise<{ ok: boolean; detail?: string }>>;
  finalizeSetupWizard: typeof FinalizeSetup;
  createFinalizeArgs: (
    flow: FinalizeArgs["flow"],
    overrides: { opts: Partial<FinalizeArgs["opts"]>; prompter: FinalizeArgs["prompter"] },
  ) => FinalizeArgs;
  startGatewayServer: unknown;
}) {
  it("shows deployment installation guidance before probing Linux systemd", async () => {
    resolveSupervisorGuidance.mockResolvedValue({
      version: 1,
      action: "install",
      name: "Example host",
      command: "examplectl install",
    });
    await withPlatform("linux", async () => {
      await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        const prompter = createLaterPrompter();

        const result = await ensureGatewayServiceForOnboarding({
          flow: "quickstart",
          opts: {},
          nextConfig: {},
          settings: { port: 18789 },
          prompter,
          runtime: createRuntime(),
        });

        expect(result).toEqual({
          gateway: { status: "skipped", reason: "external" },
          containerWithoutUserSystemd: false,
        });
        expect(isSystemdUserServiceAvailable).not.toHaveBeenCalled();
        expect(isContainerEnvironment).not.toHaveBeenCalled();
        expectNoteContains(
          prompter,
          "OpenClaw gateway lifecycle is managed by Example host",
          "Gateway",
        );
        expectNoteContains(prompter, "examplectl install", "Gateway");
        expectNoteNotContains(prompter, "Systemd user services are not available");
        expect(gatewayServiceInstall).not.toHaveBeenCalled();
      });
    });
  });

  it("preserves external supervision through unreachable container recovery", async () => {
    await withPlatform("linux", async () => {
      await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
        isSystemdUserServiceAvailable.mockResolvedValue(false);
        isContainerEnvironment.mockReturnValue(true);
        waitForGatewayReachable.mockResolvedValue({
          ok: false,
          detail: "external gateway is offline",
        });
        probeGatewayReachable.mockResolvedValue({
          ok: false,
          detail: "external gateway is offline",
        });
        const prompter = createLaterPrompter();
        await finalizeSetupWizard(
          createFinalizeArgs("advanced", {
            opts: { skipHealth: false, skipUi: false },
            prompter,
          }),
        );

        expect(isSystemdUserServiceAvailable).not.toHaveBeenCalled();
        expect(isContainerEnvironment).not.toHaveBeenCalled();
        expect(startGatewayServer).not.toHaveBeenCalled();
        expectNoteContains(prompter, "Use that supervisor to start the gateway.", "Gateway");
        expectNoteNotContains(prompter, "openclaw gateway run");
        expectNoteNotContains(prompter, "openclaw onboard --install-daemon");
        expect(prompter.outro).toHaveBeenCalledWith(
          "Gateway not detected yet. OpenClaw gateway lifecycle is managed by an external " +
            "supervisor (OPENCLAW_SUPERVISOR_MODE=external). Use that supervisor to start the " +
            "gateway.",
        );
      });
    });
  });
}
