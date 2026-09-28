import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockNodeBuiltinModule } from "../plugin-sdk/test-helpers/node-builtin-mocks.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import {
  GatewayServiceAuthorityError,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import {
  openSystemdBroker,
  openSystemdPrivatePeer,
  openSystemdUserManager,
} from "./systemd-peer-native.js";

const kernel = vi.hoisted(() => {
  const state: {
    uid: number;
    pid: number;
    startTime: number | null;
    alive: boolean;
    closes: number;
  } = {
    uid: 1000,
    pid: 1234,
    startTime: 100,
    alive: true,
    closes: 0,
  };
  return state;
});
vi.mock("../shared/pid-alive.js", () => ({
  getProcessStartTime: () => kernel.startTime,
  isPidAlive: () => kernel.alive,
}));
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return mockNodeBuiltinModule(() => Promise.resolve(original), {
    createRequire: (filename: string | URL) => {
      const require = original.createRequire(filename);
      return Object.assign(
        (specifier: string) =>
          specifier !== "koffi"
            ? require(specifier)
            : {
                sizeof: () => 24,
                struct: () => ({}),
                load: () => ({
                  func: (declaration: string) => {
                    const name = declaration.match(/\b(sd_bus_[a-z_]+)\(/)?.[1];
                    const call = (...args: unknown[]) => {
                      const slot =
                        name === "sd_bus_new"
                          ? args[0]
                          : name === "sd_bus_get_owner_creds"
                            ? args[2]
                            : args[1];
                      if (Array.isArray(slot)) {
                        slot[0] =
                          name === "sd_bus_creds_get_pid"
                            ? kernel.pid
                            : name === "sd_bus_creds_get_euid"
                              ? kernel.uid
                              : {};
                      }
                      if (name === "sd_bus_close_unref") {
                        kernel.closes++;
                      }
                      return name === "sd_bus_is_ready" ? 1 : 0;
                    };
                    return Object.assign(call, {
                      async: (...args: unknown[]) => {
                        const complete = args.pop();
                        if (typeof complete === "function") {
                          complete(null, call(...args));
                        }
                      },
                    });
                  },
                }),
              },
        require,
      );
    },
  });
});

beforeEach(() => {
  Object.assign(kernel, { uid: 1000, pid: 1234, startTime: 100, alive: true, closes: 0 });
});
afterEach(() => vi.restoreAllMocks());

const expected = { uid: 1000, pid: 1234, startTime: 100 };
const address = "unix:path=/synthetic-systemd-peer/private";

it.each([
  { name: "UID", change: { uid: 2001 } },
  { name: "PID", change: { pid: 4321 } },
  { name: "process generation", change: { startTime: 200 } },
])("preserves an observed native $name refusal", async ({ change }) => {
  Object.assign(kernel, change);
  await expect(
    openSystemdPrivatePeer(address, expected, performance.now() + 1000),
  ).rejects.toMatchObject({
    reason: "systemd-manager-changed",
  });
  expect(kernel.closes).toBe(1);
});

it.each([
  { name: "unreadable process", change: { startTime: null } },
  { name: "unavailable process", change: { alive: false } },
  { name: "invalid credentials", change: { pid: 0 } },
])("keeps $name diagnostic instead of reporting changed ownership", async ({ change }) => {
  Object.assign(kernel, change);
  const failure = await openSystemdPrivatePeer(address, expected, performance.now() + 1000).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(ServiceOwnershipRefusalError);
  expect(kernel.closes).toBe(1);
});

it("revalidates a retained peer without misclassifying a closed connection", async () => {
  const peer = await openSystemdPrivatePeer(address, expected, performance.now() + 1000);
  kernel.startTime = 200;
  expect(() => peer.verify()).toThrow(ServiceOwnershipRefusalError);
  await peer.close();
  expect(() => peer.verify()).toThrow("peer inspection is unavailable");
  expect(kernel.closes).toBe(1);
});

it("rejects an initial private manager authenticated as another account", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  kernel.uid = 2001;
  await expect(openSystemdUserManager(address, performance.now() + 1000)).rejects.toMatchObject({
    reason: "systemd-manager-changed",
  });
});

it("checks inherited update authority before loading or opening a native transport", async () => {
  const denied = new Error("original update grant retired");
  const isAuthorityRevocation = (error: unknown) =>
    error instanceof GatewayServiceAuthorityError && error.cause === denied;
  let active = true;
  let transportFailure: unknown;
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!active) {
          throw denied;
        }
      },
      async () => {
        active = false;
        try {
          await openSystemdBroker(
            "unix:path=/nonexistent-openclaw-test/bus",
            performance.now() + 100,
          );
        } catch (error) {
          transportFailure = error;
        }
      },
    ),
  ).rejects.toSatisfy(isAuthorityRevocation);
  expect(transportFailure).toSatisfy(isAuthorityRevocation);
});
