import "./update-command-service-maintenance.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  gatewayCommand,
  maintenanceDefaults,
} from "./update-command-service-fixtures.test-support.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";

const { mocks, withServiceHome, fixtureGatewayPid } =
  await import("./update-command-service-maintenance.test-support.js");

beforeEach(() => mockProcessPlatform("linux"));

const params = { ...maintenanceDefaults, phase: "inspect" as const };
const ownedIdentity = { serviceManagerUid: 2001, serviceUpdateVerdict: { kind: "owned" } };
const inspect = () => maybeStopManagedServiceBeforeMutableUpdate(params);
const prepare = (expectedService: PreManagedServiceStop) =>
  maybeStopManagedServiceBeforeMutableUpdate({ ...params, phase: "prepare", expectedService });

async function withEffectiveUid<T>(uid: number, run: () => Promise<T>): Promise<T> {
  const existingGeteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
  Object.defineProperty(process, "geteuid", { configurable: true, value: () => uid });
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
      return gatewayCommand(home);
    },
    readRuntime: async () => ({
      status: "running",
      pid: fixtureGatewayPid,
      systemd: { managerUid: managerUid() },
    }),
    isLoaded: async () => true,
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
    const before = await inspect();
    expect(before).toMatchObject(ownedIdentity);
    managerUid = scenario.uid;
    await expect(prepare(before)).rejects.toThrow(/ownership|manager identity/);
    expect(stop).not.toHaveBeenCalled();
  }),
);

it("retains the inspected systemd manager route during preparation", () =>
  withServiceHome(async (home) => {
    const seenRoutes: Array<string | undefined> = [];
    const { stop } = mockService(home, () => 2001, seenRoutes);
    const before = await inspect();
    expect(before).toMatchObject(ownedIdentity);
    const admittedRoute = "unix:path=/run/user/2001/bus";
    before.serviceEnv = { ...before.serviceEnv, DBUS_SESSION_BUS_ADDRESS: admittedRoute };
    const readsBeforePreparation = seenRoutes.length;
    await expect(prepare(before)).resolves.toMatchObject({ stopped: true, ...ownedIdentity });
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
    const before = await inspect();
    expect(before.serviceUpdateVerdict?.kind).toBe("owned");
    service.readCommand = async () => gatewayCommand(home, otherRoot);
    const failure = await prepare(before).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    for (const message of [
      "Failing check managed-service-ownership (service-ownership-changed)",
      "Required: admitted service ownership owned; manager UID 2001; detected: foreign; runtime running; manager UID 2001",
      `Update install root: ${process.cwd()}`,
      `Gateway install root: ${otherRoot}`,
      `Update binary: ${path.join(process.cwd(), "openclaw.mjs")}`,
      "Different installations: align PATH",
      "openclaw gateway status --deep",
    ]) {
      expect(failure).toMatchObject({ message: expect.stringContaining(message) });
    }
    expect(service.stop).not.toHaveBeenCalled();
  }));

it("loads a collected systemd unit from a shipped stopped handoff", () =>
  withServiceHome(async (home) =>
    withEffectiveUid(2001, async () => {
      let collected = false;
      const loadUids: Array<number | undefined> = [];
      const service = mockService(home, () => 2001);
      service.readCommand = async (_env, options) => {
        if (collected) {
          loadUids.push(options?.loadForInspection?.managerUid);
        }
        return gatewayCommand(home);
      };
      service.readRuntime = async (_env, options) => {
        if (collected) {
          loadUids.push(options?.loadForInspection?.managerUid);
        }
        return {
          status: collected ? "stopped" : "running",
          ...(collected ? {} : { pid: fixtureGatewayPid }),
          systemd: { managerUid: 2001 },
        };
      };
      const before = await inspect();
      expect(before).toMatchObject({ stopped: false, ...ownedIdentity });
      Object.assign(before, {
        stopped: true,
        stoppedAtMs: Date.now(),
        serviceManagerUid: undefined,
      });
      collected = true;
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          ...params,
          expectedService: before,
          assertCurrent: () => {},
        }),
      ).resolves.toMatchObject({ stopped: false, ...ownedIdentity });
      expect(loadUids).not.toHaveLength(0);
      expect(new Set(loadUids)).toEqual(new Set([2001]));
    }),
  ));
