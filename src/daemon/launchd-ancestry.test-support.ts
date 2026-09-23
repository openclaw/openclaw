import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "./constants.js";
import {
  createDefaultLaunchdEnv,
  createTestLaunchAgentPlist,
  defaultLaunchAgentFixture,
  defaultProgramArguments,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import {
  installLaunchAgent as installLaunchAgentImpl,
  parkCurrentLaunchAgentForMaintenance,
  resolveLaunchAgentPlistPath,
  restartLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";

/** Registers process-ancestry flows against the shared synthetic launchctl harness. */
export function registerLaunchdAncestryTests({
  state,
  getSelfAndAncestorPidsSync,
  launchdCallerPids,
  launchdRestartHandoffState,
  cleanStaleGatewayProcessesSync,
  installLaunchAgent,
}: {
  state: {
    serviceStates: Map<string, "running" | "stopped" | "not-loaded">;
    printOutput: string;
    files: Map<string, string>;
    fileWrites: unknown[];
    launchctlCalls: string[][];
  };
  getSelfAndAncestorPidsSync: ReturnType<typeof vi.fn<() => Set<number>>>;
  launchdCallerPids: number[];
  launchdRestartHandoffState: {
    scheduleDetachedLaunchdRestartHandoff: unknown;
    scheduleDetachedLaunchdMaintenancePark: unknown;
  };
  cleanStaleGatewayProcessesSync: unknown;
  installLaunchAgent: typeof installLaunchAgentImpl;
}) {
  describe("launchd process ancestry guards", () => {
    it.each(["install", "uninstall"] as const)(
      "allows external %s with stale OpenClaw service markers",
      async (action) => {
        const env = createDefaultLaunchdEnv();
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 1]));
        state.files.set(
          resolveLaunchAgentPlistPath(env),
          createTestLaunchAgentPlist({
            label: "ai.openclaw.gateway",
            programArguments: defaultProgramArguments,
          }),
        );
        await withEnvAsync(
          {
            LAUNCH_JOB_LABEL: undefined,
            LAUNCH_JOB_NAME: undefined,
            XPC_SERVICE_NAME: "0",
            OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
            OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
            OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
          },
          async () => {
            await expect(
              action === "install"
                ? installLaunchAgent(defaultLaunchAgentFixture(env))
                : uninstallLaunchAgent(launchAgentControlFixture(env)),
            ).resolves.not.toThrow();
          },
        );
        expect(getSelfAndAncestorPidsSync).toHaveBeenCalled();
      },
    );

    it.each([
      { name: "a Gateway ancestor", inside: true, servicePid: 4242 },
      { name: "an external caller", inside: false, servicePid: 4242 },
      { name: "a service PID matching the host PID", inside: false, servicePid: process.pid },
      {
        name: "a service PID matching the host parent PID",
        inside: false,
        servicePid: process.ppid,
      },
    ])("restarts without env markers with $name", async ({ inside, servicePid }) => {
      const env = createDefaultLaunchdEnv();
      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      const serviceId = `${domain}/ai.openclaw.gateway`;
      state.printOutput = ["state = running", `pid = ${servicePid}`].join("\n");
      if (inside) {
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
      }

      const result = await withEnvAsync(
        {
          LAUNCH_JOB_LABEL: undefined,
          LAUNCH_JOB_NAME: undefined,
          XPC_SERVICE_NAME: undefined,
          OPENCLAW_SERVICE_MARKER: undefined,
          OPENCLAW_SERVICE_KIND: undefined,
          OPENCLAW_LAUNCHD_LABEL: undefined,
        },
        async () => restartLaunchAgent(launchAgentControlFixture(env)),
      );

      expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
      if (inside) {
        expect(result).toEqual({ outcome: "scheduled" });
        expect(
          launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff,
        ).toHaveBeenCalledWith({
          env,
          mode: "kickstart",
          waitForPid: process.pid,
        });
        expect(state.launchctlCalls).toStrictEqual([["print", serviceId]]);
        expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ outcome: "completed" });
        expect(
          launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff,
        ).not.toHaveBeenCalled();
        expect(state.launchctlCalls).toStrictEqual([
          ["print", serviceId],
          ["enable", serviceId],
          ["kickstart", "-k", serviceId],
        ]);
      }
    });

    it.each([false, true])(
      "refuses stop without env markers with a Gateway ancestor (disable: %s)",
      async (disable) => {
        const env = createDefaultLaunchdEnv();
        const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

        await withEnvAsync(
          {
            LAUNCH_JOB_LABEL: undefined,
            LAUNCH_JOB_NAME: undefined,
            XPC_SERVICE_NAME: undefined,
            OPENCLAW_SERVICE_MARKER: undefined,
            OPENCLAW_SERVICE_KIND: undefined,
            OPENCLAW_LAUNCHD_LABEL: undefined,
          },
          async () => {
            await expect(
              stopLaunchAgent(launchAgentControlFixture(env, { disable })),
            ).rejects.toThrow(
              "Refusing to stop LaunchAgent ai.openclaw.gateway from inside the same launchd service",
            );
          },
        );

        expect(state.launchctlCalls).toEqual([["print", `${domain}/ai.openclaw.gateway`]]);
      },
    );

    it("parks without env markers when the Gateway is an ancestor", async () => {
      const env = createDefaultLaunchdEnv();
      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      const serviceId = `${domain}/ai.openclaw.gateway`;
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      await withEnvAsync(
        {
          LAUNCH_JOB_LABEL: undefined,
          LAUNCH_JOB_NAME: undefined,
          XPC_SERVICE_NAME: undefined,
          OPENCLAW_SERVICE_MARKER: undefined,
          OPENCLAW_SERVICE_KIND: undefined,
          OPENCLAW_LAUNCHD_LABEL: undefined,
        },
        async () => {
          await expect(parkCurrentLaunchAgentForMaintenance({ env })).resolves.toBe(true);
        },
      );

      expect(state.launchctlCalls).toEqual([
        ["print", serviceId],
        ["disable", serviceId],
      ]);
      expect(
        launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark,
      ).toHaveBeenCalledWith({
        env,
        waitForPid: process.pid,
      });
    });

    it.each(["install", "uninstall"] as const)(
      "refuses %s without env markers with a Gateway ancestor",
      async (action) => {
        const env = createDefaultLaunchdEnv();
        const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
        const serviceId = `${domain}/ai.openclaw.gateway`;
        state.serviceStates.set(serviceId, "running");
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

        await withEnvAsync(
          {
            LAUNCH_JOB_LABEL: undefined,
            LAUNCH_JOB_NAME: undefined,
            XPC_SERVICE_NAME: undefined,
            OPENCLAW_SERVICE_MARKER: undefined,
            OPENCLAW_SERVICE_KIND: undefined,
            OPENCLAW_LAUNCHD_LABEL: undefined,
          },
          async () => {
            await expect(
              action === "install"
                ? installLaunchAgent(defaultLaunchAgentFixture(env))
                : uninstallLaunchAgent(launchAgentControlFixture(env)),
            ).rejects.toThrow(
              `Refusing to ${action} LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway`,
            );
          },
        );

        expect(state.fileWrites).toEqual([]);
        expect(state.launchctlCalls).toEqual([["print", serviceId]]);
      },
    );

    it("refuses install from a legacy Gateway ancestor after probing the target first", async () => {
      const env = createDefaultLaunchdEnv();
      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      const serviceId = `${domain}/ai.openclaw.gateway`;
      const legacyServiceId = `${domain}/ai.openclaw.legacy-gateway`;
      state.serviceStates.set(serviceId, "not-loaded");
      state.serviceStates.set(legacyServiceId, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      await withEnvAsync(
        {
          LAUNCH_JOB_LABEL: undefined,
          LAUNCH_JOB_NAME: undefined,
          XPC_SERVICE_NAME: undefined,
          OPENCLAW_SERVICE_MARKER: undefined,
          OPENCLAW_SERVICE_KIND: undefined,
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.legacy-gateway",
        },
        async () => {
          await expect(installLaunchAgent(defaultLaunchAgentFixture(env))).rejects.toThrow(
            "Refusing to install LaunchAgent ai.openclaw.gateway from inside ai.openclaw.legacy-gateway",
          );
        },
      );

      expect(state.fileWrites).toEqual([]);
      expect(state.launchctlCalls).toEqual([
        ["print", serviceId],
        ["print", legacyServiceId],
      ]);
      expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
    });
  });
}
