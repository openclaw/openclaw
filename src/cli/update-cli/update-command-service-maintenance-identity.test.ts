// Share the native service observations and scoped state with the other maintenance suites.
import "./update-command-service-maintenance.test-support.js";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as ancestry from "../../infra/restart-stale-pids.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const { mocks, withServiceHome, fixtureGatewayPid } =
  await import("./update-command-service-maintenance.test-support.js");

beforeEach(() => {
  vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([1, process.ppid, process.pid]),
    complete: true,
  });
});

it.each([
  { label: "changed account", uid: 3002 },
  { label: "missing account", uid: undefined },
  { label: "same account", uid: 2001 },
])("revalidates native manager identity before preparation: $label", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    let managerUid: number | undefined = 2001;
    const stop = vi.fn(async () => undefined);
    mocks.service.mockReturnValue(
      createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({
          status: "running",
          pid: fixtureGatewayPid,
          systemd: { managerUid },
        }),
        isLoaded: async () => true,
        stop,
      }),
    );
    const params = {
      updateInstallKind: "package" as const,
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect" as const,
    };
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    expect(before.serviceUpdateVerdict?.kind).toBe("owned");
    expect(before).toMatchObject({ serviceManagerUid: 2001 });
    managerUid = scenario.uid;
    const next = maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "prepare",
      expectedService: before,
    });
    if (scenario.uid === 2001) {
      await expect(next).resolves.toMatchObject({
        stopped: true,
        serviceManagerUid: 2001,
        serviceUpdateVerdict: { kind: "owned" },
      });
    } else {
      await expect(next).rejects.toThrow(/ownership|manager identity/);
    }
    expect(stop).toHaveBeenCalledTimes(scenario.uid === 2001 ? 1 : 0);
  }),
);

it("retains the inspected systemd manager route during preparation", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const seenRoutes: Array<string | undefined> = [];
    mocks.service.mockReturnValue(
      createMockGatewayService({
        readCommand: async (env) => {
          seenRoutes.push(env.DBUS_SESSION_BUS_ADDRESS);
          return {
            programArguments: [
              process.execPath,
              path.join(process.cwd(), "openclaw.mjs"),
              "gateway",
            ],
            environment: { HOME: home },
          };
        },
        readRuntime: async () => ({
          status: "running",
          pid: fixtureGatewayPid,
          systemd: { managerUid: 2001 },
        }),
        isLoaded: async () => true,
        stop: async () => undefined,
      }),
    );
    const params = {
      updateInstallKind: "package" as const,
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect" as const,
    };
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    const admittedRoute = "unix:path=/run/user/2001/bus";
    before.serviceEnv = {
      ...before.serviceEnv,
      DBUS_SESSION_BUS_ADDRESS: admittedRoute,
    };
    const readsBeforePreparation = seenRoutes.length;

    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        phase: "prepare",
        expectedService: before,
      }),
    ).resolves.toMatchObject({ stopped: true });

    expect(new Set(seenRoutes.slice(readsBeforePreparation))).toEqual(new Set([admittedRoute]));
  }));
