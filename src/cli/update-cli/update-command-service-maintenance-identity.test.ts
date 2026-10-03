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
  mockProcessPlatform("linux");
  vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([1, process.ppid, process.pid]),
    complete: true,
  });
});

const params = {
  updateInstallKind: "package" as const,
  root: process.cwd(),
  shouldRestart: true,
  jsonMode: true,
  phase: "inspect" as const,
};

function mockService(
  home: string,
  managerUid: () => number | undefined,
  seenRoutes?: Array<string | undefined>,
) {
  const service = createMockGatewayService({
    readCommand: async (env) => {
      seenRoutes?.push(env.DBUS_SESSION_BUS_ADDRESS);
      return {
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      };
    },
    readRuntime: async () => ({
      status: "running",
      pid: fixtureGatewayPid,
      systemd: { managerUid: managerUid() },
    }),
    isLoaded: async () => true,
    stop: vi.fn(async () => undefined),
  });
  mocks.service.mockReturnValue(service);
  return service;
}

it.each([
  { label: "changed account", uid: 3002 },
  { label: "missing account", uid: undefined },
])("revalidates native manager identity before preparation: $label", (scenario) =>
  withServiceHome(async (home) => {
    let managerUid: number | undefined = 2001;
    const { stop } = mockService(home, () => managerUid);
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    expect(before.serviceUpdateVerdict?.kind).toBe("owned");
    expect(before).toMatchObject({ serviceManagerUid: 2001 });
    managerUid = scenario.uid;
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        phase: "prepare",
        expectedService: before,
      }),
    ).rejects.toThrow(/ownership|manager identity/);
    expect(stop).not.toHaveBeenCalled();
  }),
);

it("retains the inspected systemd manager route during preparation", () =>
  withServiceHome(async (home) => {
    const seenRoutes: Array<string | undefined> = [];
    const { stop } = mockService(home, () => 2001, seenRoutes);
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    expect(before).toMatchObject({
      serviceManagerUid: 2001,
      serviceUpdateVerdict: { kind: "owned" },
    });
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
    ).resolves.toMatchObject({
      stopped: true,
      serviceManagerUid: 2001,
      serviceUpdateVerdict: { kind: "owned" },
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(new Set(seenRoutes.slice(readsBeforePreparation))).toEqual(new Set([admittedRoute]));
  }));
