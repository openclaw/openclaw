import os from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import type { SystemdServiceIdentity } from "./service-types.js";
import {
  restartSystemdService,
  startSystemdService,
  stopSystemdService,
} from "./systemd-lifecycle.js";
import { captureSystemdServiceIdentity } from "./systemd-service-identity.js";

const native = vi.hoisted(() => ({
  query:
    vi.fn<
      Awaited<ReturnType<typeof import("./systemd-peer-native.js").openSystemdBroker>>["query"]
    >(),
  open: vi.fn(),
  close: vi.fn(async () => {}),
  systemctl: vi.fn(async () => ({ code: 0, termination: "exit", stdout: "", stderr: "" })),
}));
vi.mock("./systemd-peer-native.js", () => ({
  openSystemdBroker: native.open,
  openSystemdMachineBroker: native.open,
}));
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  execSystemctl: native.systemctl,
  execSystemctlUser: native.systemctl,
}));
vi.mock("./systemd-scope.js", () => ({
  findInstalledSystemdGatewayScope: async () => ({
    scope: "system",
    unitName: "openclaw.service",
    unitPath: "/etc/systemd/system/openclaw.service",
  }),
}));

const original = {
  scope: "system",
  unitName: "openclaw.service",
  unitPath: "/etc/systemd/system/openclaw.service",
  bus: { address: "unix:path=/synthetic-systemd-test/bus" },
  busId: "0123456789abcdef0123456789abcdef",
  managerOwner: ":1.42",
  managerUid: 0,
  serviceUser: "root",
} satisfies SystemdServiceIdentity;
let current: SystemdServiceIdentity;
let effects: string[];
let afterReset: (() => void) | undefined;
let resetFailure: Error | undefined;
const options = () => ({ stdout: new PassThrough(), systemdIdentity: original });
const captureAdopted = () =>
  captureSystemdServiceIdentity({
    env: {},
    target: original,
    managerUid: 0,
    rootServiceAccount: "openclaw-fixture",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "root",
    uid: 0,
    gid: 0,
    homedir: "/root",
    shell: "/bin/sh",
  });
  current = { ...original };
  effects = [];
  afterReset = undefined;
  resetFailure = undefined;
  native.open.mockResolvedValue({ query: native.query, close: native.close, verify: () => {} });
  native.query.mockImplementation(
    async (args, _signatures, _deadline, assertCurrent, beforeDispatch) => {
      assertCurrent?.();
      const method = args[4];
      if (!method) {
        throw new Error("Missing synthetic native method");
      }
      if (method === "GetId") {
        return [[current.busId]];
      }
      if (method === "GetNameOwner") {
        return [[current.managerOwner]];
      }
      if (method === "GetConnectionUnixUser") {
        return [[current.managerUid]];
      }
      if (method === "GetUnit" || method === "LoadUnit") {
        return [["/org/freedesktop/systemd1/unit/openclaw_2eservice"]];
      }
      if (args[0] === "get-property") {
        return method === "Id" ? [current.unitName, current.unitPath] : [current.serviceUser];
      }
      if (["ResetFailedUnit", "StartUnit", "StopUnit", "RestartUnit"].includes(method)) {
        expect(args[1]).toBe(original.managerOwner);
        beforeDispatch?.();
        effects.push(method);
        if (method === "ResetFailedUnit") {
          afterReset?.();
          if (resetFailure) {
            throw resetFailure;
          }
          return [];
        }
        return [["/org/freedesktop/systemd1/job/7"]];
      }
      throw new Error(`Unexpected synthetic native query: ${method}`);
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const changes = [
  ["account reassignment", { serviceUser: "another-account" }, "systemd-account-refused"],
  ["same-account manager replacement", { managerOwner: ":1.99" }, "systemd-manager-changed"],
  [
    "broker replacement reusing the manager name",
    { busId: "abcdef0123456789abcdef0123456789" },
    "systemd-manager-changed",
  ],
  ["manager account replacement", { managerUid: 2001 }, "systemd-manager-changed"],
  [
    "definition replacement",
    { unitPath: "/etc/systemd/system/other.service" },
    "systemd-unit-changed",
  ],
] as const;

it.each(["before start", "during restart"])("refuses changed authority %s", async (phase) => {
  for (const [name, change, reason] of changes) {
    vi.clearAllMocks();
    effects = [];
    current = { ...original };
    const replace = () => {
      current = { ...current, ...change };
    };
    afterReset = phase === "during restart" ? replace : undefined;
    if (phase === "before start") {
      replace();
    }
    const activate = phase === "before start" ? startSystemdService : restartSystemdService;
    await expect(activate(options()), name).rejects.toMatchObject({
      name: "ServiceOwnershipRefusalError",
      reason,
    });
    expect(effects).toEqual(phase === "before start" ? [] : ["ResetFailedUnit"]);
    expect(native.systemctl).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
  }
});

it("accepts root account aliases", async () => {
  for (const serviceUser of ["", "root", "0"]) {
    vi.clearAllMocks();
    effects = [];
    current.serviceUser = serviceUser;
    await startSystemdService(options());
    expect(effects).toEqual(["ResetFailedUnit", "StartUnit"]);
    expect(native.open).toHaveBeenCalledExactlyOnceWith(original.bus.address, expect.any(Number));
    expect(native.systemctl).not.toHaveBeenCalled();
  }
});

it("retains the root privilege requirement for a pinned system unit", async () => {
  vi.spyOn(process, "geteuid").mockReturnValue(2001);
  await expect(
    startSystemdService({ stdout: new PassThrough(), systemdIdentity: original }),
  ).rejects.toThrow("sudo systemctl start openclaw.service");
  expect(native.open).not.toHaveBeenCalled();
  expect(native.systemctl).not.toHaveBeenCalled();
});

it("never falls back to an unbound manager when activation inspection fails", async () => {
  native.query.mockRejectedValueOnce(new Error("native inspection unavailable"));
  await expect(startSystemdService(options())).rejects.toThrow("native inspection unavailable");
  expect(effects).toEqual([]);
  expect(native.systemctl).not.toHaveBeenCalled();
  expect(native.close).toHaveBeenCalledOnce();
});

it("warns and still attempts start when only reset-failed fails", async () => {
  resetFailure = new Error("reset-failed unavailable");
  const warn = vi.fn();
  await startSystemdService({ ...options(), warn });
  expect(effects).toEqual(["ResetFailedUnit", "StartUnit"]);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("reset-failed did not complete"),
  );
});

it("does not downgrade an ownership refusal from reset-failed", async () => {
  resetFailure = new ServiceOwnershipRefusalError("systemd-account-refused");
  const warn = vi.fn();
  await expect(startSystemdService({ ...options(), warn })).rejects.toBe(resetFailure);
  expect(effects).toEqual(["ResetFailedUnit"]);
  expect(warn).not.toHaveBeenCalled();
});

it("does not downgrade lost custody during reset-failed", async () => {
  const retired = new Error("original maintenance custody retired");
  let active = true;
  afterReset = () => {
    active = false;
  };
  resetFailure = new Error("reset-failed interrupted");
  const warn = vi.fn();
  await expect(
    startSystemdService({
      ...options(),
      warn,
      assertCurrent: () => {
        if (!active) {
          throw retired;
        }
      },
    }),
  ).rejects.toBe(retired);
  expect(effects).toEqual(["ResetFailedUnit"]);
  expect(warn).not.toHaveBeenCalled();
});

it("captures the selected native owner before stop without any mutation", async () => {
  vi.stubEnv("DBUS_SYSTEM_BUS_ADDRESS", original.bus.address);
  const { scope, unitName, unitPath } = original;
  const identity = await captureSystemdServiceIdentity({
    env: {},
    target: { scope, unitName, unitPath },
    managerUid: original.managerUid,
  });
  expect(identity).toEqual(original);
  expect(effects).toEqual([]);
  expect(native.query.mock.calls.some(([args]) => args[4] === "LoadUnit")).toBe(false);
  expect(native.close).toHaveBeenCalledOnce();
});

it("refuses to capture authority for another service account", async () => {
  current.serviceUser = "another-account";
  await expect(
    captureSystemdServiceIdentity({ env: {}, target: original, managerUid: 0 }),
  ).rejects.toBeInstanceOf(ServiceOwnershipRefusalError);
  expect(effects).toEqual([]);
});

it("root can retain the explicitly adopted non-root account through pinned stop and start", async () => {
  current.serviceUser = "openclaw-fixture";
  const identity = await captureAdopted();
  await stopSystemdService({ stdout: new PassThrough(), systemdIdentity: identity });
  await startSystemdService({ stdout: new PassThrough(), systemdIdentity: identity });
  expect(effects).toEqual(["StopUnit", "ResetFailedUnit", "StartUnit"]);
  expect(native.systemctl).not.toHaveBeenCalled();
});

it.each(["other-account", "root"])("an adopted account never admits %s", async (replacement) => {
  current.serviceUser = "openclaw-fixture";
  const identity = await captureAdopted();
  current.serviceUser = replacement;
  await expect(
    stopSystemdService({ stdout: new PassThrough(), systemdIdentity: identity }),
  ).rejects.toMatchObject({ reason: "systemd-account-refused" });
  expect(effects).toEqual([]);
});

it("refuses an explicit adopted account to a non-root inspector", async () => {
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  current.serviceUser = "openclaw-fixture";
  await expect(captureAdopted()).rejects.toMatchObject({ reason: "systemd-account-refused" });
  expect(effects).toEqual([]);
});

it("checks effect-specific process facts after native inspection without requiring them after stop", async () => {
  let serving = true;
  native.query.mockImplementationOnce(async () => {
    // An asynchronous pre-effect revalidation may lose the observed process.
    serving = false;
    return [[current.busId]];
  });
  await expect(
    stopSystemdService({
      ...options(),
      assertCurrent: () => {},
      beforeEffect: () => {
        if (!serving) {
          throw new Error("process replaced");
        }
      },
    }),
  ).rejects.toThrow("process replaced");
  expect(effects).toEqual([]);
});

it("does not downgrade a final effect guard refusal from reset-failed into a start", async () => {
  const denied = new Error("original stopped-service custody ended");
  const warn = vi.fn();
  await expect(
    startSystemdService({
      ...options(),
      warn,
      beforeEffect: () => {
        throw denied;
      },
    }),
  ).rejects.toBe(denied);
  expect(effects).toEqual([]);
  expect(warn).not.toHaveBeenCalled();
});
