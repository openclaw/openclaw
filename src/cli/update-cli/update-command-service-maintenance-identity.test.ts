// Share the native service observations and scoped state with the other maintenance suites.
import "./update-command-service-maintenance.test-support.js";
import fs from "node:fs/promises";
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

async function withEffectiveUid<T>(uid: number, run: () => Promise<T>): Promise<T> {
  const existingGeteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
  Object.defineProperty(process, "geteuid", {
    configurable: true,
    value: () => uid,
  });
  try {
    return await run();
  } finally {
    if (existingGeteuid) {
      Object.defineProperty(process, "geteuid", existingGeteuid);
    } else {
      Reflect.deleteProperty(process, "geteuid");
    }
  }
}

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

it("names both installations when the admitted Gateway command moves to another install", () =>
  withServiceHome(async (home) => {
    const otherRoot = path.join(home, "other-openclaw");
    await fs.mkdir(otherRoot);
    await fs.writeFile(path.join(otherRoot, "package.json"), '{"name":"openclaw"}');
    await fs.writeFile(path.join(otherRoot, "openclaw.mjs"), "");
    const service = mockService(home, () => 2001);
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    expect(before.serviceUpdateVerdict?.kind).toBe("owned");
    service.readCommand = async () => ({
      programArguments: [process.execPath, path.join(otherRoot, "openclaw.mjs"), "gateway"],
      environment: { HOME: home },
    });
    const failure = await maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "prepare",
      expectedService: before,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected installation ownership refusal");
    }
    expect(failure.message).toContain(
      "Failing check managed-service-ownership (service-ownership-changed)",
    );
    expect(failure.message).toContain(
      "Required: admitted service ownership owned; manager UID 2001; detected: foreign; runtime running; manager UID 2001",
    );
    expect(failure.message).toContain(`Update install root: ${process.cwd()}`);
    expect(failure.message).toContain(`Gateway install root: ${otherRoot}`);
    expect(failure.message).toContain(`Update binary: ${path.join(process.cwd(), "openclaw.mjs")}`);
    expect(failure.message).toContain("Different installations: align PATH");
    expect(failure.message).toContain("openclaw gateway status --deep");
    expect(service.stop).not.toHaveBeenCalled();
  }));

it("loads a collected systemd unit from a shipped stopped handoff", () =>
  withServiceHome(async (home) =>
    withEffectiveUid(2001, async () => {
      const managerUid = 2001;
      let collected = false;
      const loadUids: Array<number | undefined> = [];
      const service = createMockGatewayService({
        readCommand: async (_env, options) => {
          if (collected) {
            loadUids.push(options?.loadForInspection?.managerUid);
          }
          return {
            programArguments: [
              process.execPath,
              path.join(process.cwd(), "openclaw.mjs"),
              "gateway",
            ],
            environment: { HOME: home },
          };
        },
        readRuntime: async (_env, options) => {
          if (collected) {
            loadUids.push(options?.loadForInspection?.managerUid);
          }
          return {
            status: collected ? "stopped" : "running",
            ...(collected ? {} : { pid: fixtureGatewayPid }),
            systemd: { managerUid },
          };
        },
        isLoaded: async () => true,
      });
      mocks.service.mockReturnValue(service);

      const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
      expect(before).toMatchObject({
        stopped: false,
        serviceManagerUid: managerUid,
        serviceUpdateVerdict: { kind: "owned" },
      });
      before.stopped = true;
      before.stoppedAtMs = Date.now();
      before.serviceManagerUid = undefined;
      collected = true;

      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          ...params,
          expectedService: before,
          assertCurrent: () => {},
        }),
      ).resolves.toMatchObject({
        stopped: false,
        serviceManagerUid: managerUid,
        serviceUpdateVerdict: { kind: "owned" },
      });
      expect(loadUids).not.toHaveLength(0);
      expect(new Set(loadUids)).toEqual(new Set([managerUid]));
    }),
  ));
