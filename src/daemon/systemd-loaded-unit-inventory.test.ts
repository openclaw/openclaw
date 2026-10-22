import fs from "node:fs/promises";
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import { assertManagedGatewayArtifactPublication } from "../cli/update-cli/update-command-service-revalidation.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as processes from "../shared/pid-alive.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import type { ExecResult } from "./exec-file.js";
import type { GatewayServiceState } from "./service-types.js";
import * as gatewayService from "./service.js";
import * as systemdServiceFiles from "./systemd-service-files.js";

const systemctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execSystemctl>());
const userctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execSystemctlUser>());
const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlSystem>());
const connect = vi.hoisted(() => vi.fn());
const connectPrivate = vi.hoisted(() => vi.fn());
const root = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-user-transport.js").resolveSystemdUserTransport>(),
);
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  execSystemctl: systemctl,
  execSystemctlUser: userctl,
  execBusctlSystem: busctl,
  isRunningAsRoot: root,
}));
vi.mock("@openclaw/proc-safe/systemd", async (original) => ({
  ...(await original<typeof import("@openclaw/proc-safe/systemd")>()),
  SystemdBus: {
    connectBroker: connect,
    connectUserManager: connect,
    connectMachineBroker: connect,
    connectPrivatePeer: connectPrivate,
  },
}));
vi.mock("./systemd-user-transport.js", async (original) => ({
  ...(await original<typeof import("./systemd-user-transport.js")>()),
  resolveSystemdUserTransport: transport,
}));

import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import { listLoadedSystemdUnits } from "./systemd-loaded-unit-inventory.js";

const success = (stdout: string): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});
const programArguments = ["/usr/bin/node", "/opt/openclaw/dist/entry.js", "gateway"];
const buses = {
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/user-bus",
  DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/fixture/system-bus",
};
type Unit = { name: string; fragmentPath: string; state: string; argv: string[] };
const units = new Map<string, Unit>();
let managerOwner = ":1.42";
let busId = "0123456789abcdef0123456789abcdef";
const nativeBus = {
  close: vi.fn(async () => {}),
  call: vi.fn(async (target: { member: string }, args: { value: string }[]) => {
    if (target.member === "GetNameOwner") {
      return [managerOwner];
    }
    if (target.member === "GetConnectionUnixUser") {
      return [0];
    }
    if (target.member === "GetUnit" && units.has(args[0]!.value)) {
      return [`/org/freedesktop/systemd1/unit/unit${[...units.keys()].indexOf(args[0]!.value)}`];
    }
    throw new ProcSafeError("operation-failed", "No loaded unit", {
      details: { dbusErrorName: "org.freedesktop.systemd1.NoSuchUnit" },
    });
  }),
  getProperty: vi.fn(async (target: { path: string; member: string }) => {
    const index = Number(target.path.split("/unit/unit")[1]);
    const unit = [...units.values()][index]!;
    switch (target.member) {
      case "Id":
        return unit.name;
      case "FragmentPath":
        return unit.fragmentPath;
      case "ActiveState":
        return unit.state;
      case "ExecStart":
        return [[unit.argv[0], unit.argv, false, 0n, 0n, 0n, 0n, 0, 0, 0]];
      default:
        throw new Error("Unexpected property");
    }
  }),
};
const readProperty = nativeBus.getProperty.getMockImplementation()!;
function addUnit(
  name: string,
  fragmentPath = `/run/systemd/transient/${name}`,
  argv = programArguments,
) {
  units.set(name, { name, fragmentPath, state: "active", argv });
}
const listEntry = (name: string) => success(`${name} loaded active running Gateway\n`);

function withFixture(work: (home: string) => Promise<void>) {
  return withTestDir({ prefix: "openclaw-loaded-unit-" }, async (home) => {
    userctl.mockResolvedValue(success(""));
    systemctl.mockResolvedValue(success(""));
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    await work(home).finally(() => vi.restoreAllMocks());
  });
}
const withLinuxFixture = (work: (home: string) => Promise<void>) =>
  withMockedPlatform("linux", () => withFixture(work));
const publication = (checkoutRoot: string, env: Record<string, string>) =>
  assertManagedGatewayArtifactPublication({
    roots: [checkoutRoot],
    env,
    timeoutMs: 5_000,
    assertCurrent() {},
    updateInstallKind: "package",
    shouldRestart: true,
  });

beforeEach(() => {
  vi.stubEnv("PROC_SAFE_NATIVE", "auto");
  systemctl.mockReset();
  userctl.mockReset();
  busctl.mockReset();
  units.clear();
  managerOwner = ":1.42";
  busId = "0123456789abcdef0123456789abcdef";
  vi.stubEnv("SYSTEMCTL_FORCE_BUS", "");
  root.mockReset().mockReturnValue(false);
  nativeBus.call.mockClear();
  nativeBus.getProperty.mockReset().mockImplementation(readProperty);
  nativeBus.close.mockReset().mockResolvedValue();
  connect.mockReset().mockResolvedValue(nativeBus);
  connectPrivate.mockReset().mockResolvedValue({ ...nativeBus, peer: { uid: 0, pid: 1 } });
  transport.mockReset().mockResolvedValue({
    kind: "runtime-bus",
    address: buses.DBUS_SESSION_BUS_ADDRESS,
    runtimeDir: "/fixture",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("rejects partial loaded-unit properties", async () => {
  const name = "custom-rescue.service";
  addUnit(name);
  units.get(name)!.name = "unrelated.service";
  systemctl.mockResolvedValue(listEntry(name));
  await expect(
    listLoadedSystemdUnits("system", {
      DBUS_SYSTEM_BUS_ADDRESS: buses.DBUS_SYSTEM_BUS_ADDRESS,
    }),
  ).rejects.toThrow("properties could not be inspected");
});

it("keeps multiline command data separate from every loaded unit's identity", async () => {
  const payload =
    "print('hello')\n\nId=hidden.service\nActiveState=inactive\nFragmentPath=/false\n";
  addUnit("custom-rescue.service", "/run/systemd/transient/custom-rescue.service", [
    "/usr/bin/python3",
    "-c",
    payload,
  ]);
  addUnit("openclaw-gateway.service");
  systemctl.mockImplementation(async (args) =>
    success(
      args.includes("list-units")
        ? "custom-rescue.service loaded active running Worker\nopenclaw-gateway.service loaded active running Gateway\n"
        : [...units.values()]
            .map(
              (unit) =>
                `Id=${unit.name}\nActiveState=active\nFragmentPath=${unit.fragmentPath}\nExecStart={ path=${unit.argv[0]} ; argv[]=${unit.argv.join(" ")} ; ignore_errors=no ; start_time=[] ; stop_time=[] ; pid=0 ; code=(null) ; status=0 }\n`,
            )
            .join("\n"),
    ),
  );
  expect(await listLoadedSystemdUnits("system", buses)).toEqual([
    {
      name: "custom-rescue.service",
      fragmentPath: "/run/systemd/transient/custom-rescue.service",
      commands: [
        { path: "/usr/bin/python3", programArguments: ["/usr/bin/python3", "-c", payload] },
      ],
    },
    {
      name: "openclaw-gateway.service",
      fragmentPath: "/run/systemd/transient/openclaw-gateway.service",
      commands: [{ path: "/usr/bin/node", programArguments }],
    },
  ]);
  expect(connect).toHaveBeenCalledOnce();
  expect(nativeBus.close).toHaveBeenCalledOnce();
  expect(busctl).not.toHaveBeenCalled();
});

it.each(["missing unit", "malformed commands", "replaced manager"])(
  "rejects incomplete inventory: %s",
  async (failure) => {
    const name = "custom-rescue.service";
    systemctl.mockResolvedValue(listEntry(name));
    if (failure !== "missing unit") {
      addUnit(name);
    }
    nativeBus.getProperty.mockImplementation(async (target) => {
      const value = await readProperty(target);
      if (target.member === "ExecStart") {
        if (failure === "malformed commands") {
          return "not an execution array";
        }
        managerOwner = ":1.99";
      }
      return value;
    });
    await expect(listLoadedSystemdUnits("system", buses)).rejects.toThrow();
    expect(nativeBus.close).toHaveBeenCalledOnce();
    expect(busctl).not.toHaveBeenCalled();
  },
);

it.each([
  { mode: "off", forcedRoot: false },
  { mode: "missing addon", forcedRoot: false },
  { mode: "off", forcedRoot: true },
  { mode: "missing addon", forcedRoot: true },
])(
  "preserves typed CLI inspection with $mode (forced root=$forcedRoot)",
  async ({ mode, forcedRoot }) => {
    const name = "custom-rescue.service";
    addUnit(name);
    if (forcedRoot) {
      root.mockReturnValue(true);
      vi.stubEnv("SYSTEMCTL_FORCE_BUS", "1");
      vi.stubEnv("DBUS_SYSTEM_BUS_ADDRESS", buses.DBUS_SYSTEM_BUS_ADDRESS);
    }
    systemctl.mockResolvedValue(listEntry(name));
    if (mode === "off") {
      vi.stubEnv("PROC_SAFE_NATIVE", "off");
    } else {
      connect.mockRejectedValue(new ProcSafeError("helper-unavailable", "Native addon absent"));
    }
    busctl.mockImplementation(async (args) => {
      expect(args).toContain("--auto-start=no");
      expect(args).not.toContain("LoadUnit");
      const property = (type: string, data: unknown) => JSON.stringify({ type, data });
      if (args.includes("GetId")) {
        return success(property("s", [busId]));
      }
      if (args.includes("GetNameOwner")) {
        return success(property("s", [managerOwner]));
      }
      if (args.includes("GetConnectionUnixUser")) {
        return success(property("u", [0]));
      }
      if (args.includes("GetUnit")) {
        return success(property("o", ["/org/freedesktop/systemd1/unit/unit0"]));
      }
      if (args.includes("org.freedesktop.systemd1.Unit")) {
        return success(
          [
            property("s", name),
            property("s", `/run/systemd/transient/${name}`),
            property("s", "active"),
          ].join("\n"),
        );
      }
      return success(
        property("a(sasbttttuii)", [
          ["/usr/bin/node", programArguments, false, 0, 0, 0, 0, 0, 0, 0],
        ]),
      );
    });
    expect(await listLoadedSystemdUnits("system", buses)).toEqual([
      {
        name,
        fragmentPath: `/run/systemd/transient/${name}`,
        commands: [{ path: "/usr/bin/node", programArguments }],
      },
    ]);
    expect(connectPrivate).not.toHaveBeenCalled();
    expect(nativeBus.close).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "pins the manager before listing, including empty results (%s)",
  async (empty) => {
    addUnit("custom-rescue.service");
    systemctl.mockImplementation(async () => {
      managerOwner = ":1.99";
      return empty ? success("") : listEntry("custom-rescue.service");
    });
    await expect(listLoadedSystemdUnits("system", buses)).rejects.toMatchObject({
      reason: "systemd-manager-changed",
    });
    expect(nativeBus.close).toHaveBeenCalledOnce();
  },
);

it("refuses a replacement CLI bus that reuses the manager name and UID", async () => {
  vi.stubEnv("PROC_SAFE_NATIVE", "off");
  busctl.mockImplementation(async (args) =>
    success(
      JSON.stringify({
        type: args.includes("GetConnectionUnixUser") ? "u" : "s",
        data: [
          args.includes("GetId")
            ? busId
            : args.includes("GetConnectionUnixUser")
              ? 0
              : managerOwner,
        ],
      }),
    ),
  );
  systemctl.mockImplementation(async () => {
    busId = "fedcba9876543210fedcba9876543210";
    return success("");
  });
  await expect(listLoadedSystemdUnits("system", buses)).rejects.toMatchObject({
    reason: "systemd-manager-changed",
  });
});

it("does not give a late listing a fresh property deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  systemctl.mockImplementation(async () => {
    now = 16_000;
    return success("");
  });
  await expect(listLoadedSystemdUnits("system", buses)).rejects.toMatchObject({
    reason: "systemd-inspection-deadline-exceeded",
  });
  expect(nativeBus.close).toHaveBeenCalledOnce();
  expect(nativeBus.getProperty).not.toHaveBeenCalled();
});

it.each(["", "t"])("preserves the root system-manager route (forced bus=%s)", async (forceBus) => {
  root.mockReturnValue(true);
  vi.stubEnv("SYSTEMCTL_FORCE_BUS", forceBus);
  vi.spyOn(processes, "getProcessStartTime").mockReturnValue(100);
  vi.spyOn(processes, "isPidAlive").mockReturnValue(true);
  addUnit("custom-rescue.service");
  systemctl.mockResolvedValue(listEntry("custom-rescue.service"));
  expect(await listLoadedSystemdUnits("system", buses)).toEqual([
    {
      name: "custom-rescue.service",
      fragmentPath: "/run/systemd/transient/custom-rescue.service",
      commands: [{ path: "/usr/bin/node", programArguments }],
    },
  ]);
  if (forceBus) {
    expect(connect).toHaveBeenCalledOnce();
    expect(connectPrivate).not.toHaveBeenCalled();
  } else {
    expect(connectPrivate).toHaveBeenCalledWith(
      "unix:path=/run/systemd/private",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(nativeBus.call.mock.calls.every(([target]) => target.member === "GetUnit")).toBe(true);
  }
  expect(nativeBus.close).toHaveBeenCalledOnce();
});

it("refuses a private system-manager identity mismatch without broker fallback", async () => {
  root.mockReturnValue(true);
  vi.spyOn(processes, "getProcessStartTime").mockReturnValue(100);
  vi.spyOn(processes, "isPidAlive").mockReturnValue(true);
  connectPrivate.mockResolvedValue({ ...nativeBus, peer: { uid: 1000, pid: 1 } });
  await expect(listLoadedSystemdUnits("system", buses)).rejects.toMatchObject({
    reason: "systemd-manager-changed",
  });
  expect(nativeBus.close).toHaveBeenCalledOnce();
  expect(systemctl).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(busctl).not.toHaveBeenCalled();
});

it.each(["off", "missing addon"])(
  "refuses a different broker for root private-manager inspection (%s)",
  async (mode) => {
    root.mockReturnValue(true);
    vi.stubEnv("DBUS_SYSTEM_BUS_ADDRESS", buses.DBUS_SYSTEM_BUS_ADDRESS);
    vi.spyOn(processes, "getProcessStartTime").mockReturnValue(100);
    const name = "custom-rescue.service";
    systemctl.mockResolvedValue(listEntry(name));
    if (mode === "off") {
      vi.stubEnv("PROC_SAFE_NATIVE", "off");
    } else {
      connectPrivate.mockRejectedValue(
        new ProcSafeError("helper-unavailable", "Native addon absent"),
      );
    }
    // The alternate broker is stable and UID 0, but its same-named unit is inactive.
    busctl.mockImplementation(async (args) => {
      const property = (type: string, data: unknown) => JSON.stringify({ type, data });
      if (args.includes("GetId")) {
        return success(property("s", [busId]));
      }
      if (args.includes("GetNameOwner")) {
        return success(property("s", [managerOwner]));
      }
      if (args.includes("GetConnectionUnixUser")) {
        return success(property("u", [0]));
      }
      if (args.includes("GetUnit")) {
        return success(property("o", ["/org/freedesktop/systemd1/unit/unit0"]));
      }
      if (args.includes("org.freedesktop.systemd1.Unit")) {
        return success(
          [
            property("s", name),
            property("s", `/run/systemd/transient/${name}`),
            property("s", "inactive"),
          ].join("\n"),
        );
      }
      return success(
        property("a(sasbttttuii)", [
          ["/usr/bin/node", programArguments, false, 0, 0, 0, 0, 0, 0, 0],
        ]),
      );
    });
    await expect(listLoadedSystemdUnits("system", buses)).rejects.toThrow(
      "selected systemd private manager requires native inspection support",
    );
    expect(systemctl).not.toHaveBeenCalled();
    expect(busctl).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(nativeBus.close).not.toHaveBeenCalled();
  },
);

it.each([
  { mode: "require", code: "helper-unavailable" },
  { mode: "invalid", code: "invalid-argument" },
  { mode: "auto", code: "access-denied" },
  { mode: "auto", code: "incomplete" },
] as const)("does not change transport after $mode/$code", async ({ mode, code }) => {
  vi.stubEnv("PROC_SAFE_NATIVE", mode);
  systemctl.mockResolvedValue(listEntry("custom-rescue.service"));
  const failure = new ProcSafeError(code, "Synthetic native refusal");
  connect.mockRejectedValue(failure);
  await expect(listLoadedSystemdUnits("system", buses)).rejects.toBe(failure);
  expect(busctl).not.toHaveBeenCalled();
});

it("reports private-only native-off inspection as unavailable, never empty", async () => {
  vi.stubEnv("PROC_SAFE_NATIVE", "off");
  userctl.mockResolvedValue(listEntry("custom-rescue.service"));
  transport.mockResolvedValue({
    kind: "private",
    address: "unix:path=/fixture/private",
    runtimeDir: "/fixture",
  });
  await expect(listLoadedSystemdUnits("user", buses)).rejects.toMatchObject({
    reason: "systemd-user-bus-unavailable",
  });
  expect(connect).not.toHaveBeenCalled();
  expect(busctl).not.toHaveBeenCalled();
});

it("preserves both failed inspection and connection cleanup", async () => {
  addUnit("custom-rescue.service");
  systemctl.mockResolvedValue(listEntry("custom-rescue.service"));
  const inspection = new Error("Synthetic inspection failure");
  const cleanup = new CommandProcessCleanupError();
  nativeBus.getProperty.mockRejectedValueOnce(inspection);
  nativeBus.close.mockRejectedValueOnce(cleanup);
  await expect(listLoadedSystemdUnits("system", buses)).rejects.toMatchObject({
    errors: [inspection, cleanup],
    cause: cleanup,
  });
  expect(nativeBus.close).toHaveBeenCalledOnce();
  expect(busctl).not.toHaveBeenCalled();
});

it("joins connection close before refusing an expired inventory", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  addUnit("custom-rescue.service");
  systemctl.mockResolvedValue(listEntry("custom-rescue.service"));
  let closed = false;
  nativeBus.close.mockImplementationOnce(async () => {
    now = 16_000;
    closed = true;
  });
  await expect(listLoadedSystemdUnits("system", buses)).rejects.toMatchObject({
    reason: "systemd-inspection-deadline-exceeded",
  });
  expect(closed).toBe(true);
});

it.each(
  (["user", "system"] as const).flatMap((scope) =>
    [false, true].map((uncertain) => ({ scope, uncertain })),
  ),
)("preserves cleanup custody: $scope uncertain=$uncertain", ({ scope, uncertain }) =>
  withLinuxFixture(async (home) => {
    const failure = uncertain
      ? new CommandProcessCleanupError()
      : new Error("Synthetic service inventory unavailable");
    const native = scope === "user" ? userctl : systemctl;
    native.mockRejectedValue(failure);
    const publishing = publication(home, { HOME: home, ...buses });
    if (uncertain) {
      await expect(publishing).rejects.toBe(failure);
    } else {
      await expect(publishing).resolves.toBeUndefined();
    }
    expect(native).toHaveBeenCalled();
  }),
);

it.skipIf(process.platform !== "linux")("binds removed custom-profile units", () =>
  withFixture(async (home) => {
    const name = "openclaw-gateway-rescue.service";
    const removedPath = path.join(home, name);
    addUnit(name, removedPath);
    userctl.mockResolvedValue(listEntry(name));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_CONFIG_DIRS: home,
      XDG_DATA_DIRS: home,
      XDG_RUNTIME_DIR: home,
      ...buses,
    };
    expect(await listLoadedSystemdUnits("user", env)).toEqual([
      { name, fragmentPath: removedPath, commands: [{ path: "/usr/bin/node", programArguments }] },
    ]);
    expect(await discoverManagedGatewayBindings(env, { requireComplete: true })).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_SYSTEMD_UNIT: name }),
        systemdReadTarget: { scope: "user", unitName: name, unitPath: removedPath },
      }),
    ]);
    const checkout = path.join(home, "checkout");
    await fs.mkdir(path.join(checkout, "dist"), { recursive: true });
    await fs.writeFile(path.join(checkout, "package.json"), '{"name":"openclaw"}\n');
    await fs.writeFile(path.join(checkout, "dist/index.js"), "gateway\n");
    const command = {
      programArguments: [process.execPath, path.join(checkout, "dist/index.js"), "gateway"],
      sourcePath: removedPath,
    };
    vi.spyOn(systemdServiceFiles, "readSystemdServiceCommandLocation").mockImplementation(
      async (_env, target) =>
        target?.unitName === name ? { kind: "command", command } : { kind: "not-loaded" },
    );
    vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {},
      command,
    } satisfies GatewayServiceState);
    const writes = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("unexpected write"));
    await expect(
      resolveLiveManagedGatewayDistFence(checkout, { env, requireVerified: true }),
    ).resolves.toMatchObject({ refuse: true });
    await expect(publication(checkout, env)).rejects.toThrow(
      `another managed Gateway (systemd user unit ${JSON.stringify(name)})`,
    );
    expect(writes).not.toHaveBeenCalled();
  }),
);

it.each([false, true])("fences possible managers (present=%s)", (present) =>
  withLinuxFixture(async (home) => {
    vi.spyOn(fs, "lstat").mockRejectedValue(
      Object.assign(new Error("Synthetic path absent"), { code: "ENOENT" }),
    );
    for (const native of [userctl, systemctl]) {
      native.mockRejectedValue(new Error("Synthetic advertised manager inaccessible"));
    }
    const env = {
      HOME: home,
      XDG_RUNTIME_DIR: home,
      ...(present ? { DBUS_SESSION_BUS_ADDRESS: buses.DBUS_SESSION_BUS_ADDRESS } : {}),
    };
    await expect(
      resolveLiveManagedGatewayDistFence(home, { env, requireVerified: true }),
    ).resolves.toMatchObject({ refuse: present });
  }),
);
