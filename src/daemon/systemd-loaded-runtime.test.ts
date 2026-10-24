import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExecResult } from "./exec-file.js";

const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
const systemBusctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlSystem>());
const systemctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execSystemctlUser>());
vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  execBusctlUser: busctl,
  execBusctlSystem: systemBusctl,
  execSystemctlUser: systemctl,
  assertSystemdAvailable: async () => {},
}));
vi.mock("./systemd-scope.js", () => ({ findInstalledSystemdGatewayScope: async () => null }));
import { readSystemdServiceRuntime } from "./systemd-runtime.js";

const env = {
  HOME: "/test/owned",
  OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
  OPENCLAW_PROFILE: "owned",
};
const unitName = "openclaw-owned.service";
const unitPath = "/org/freedesktop/systemd1/unit/openclaw_2downed_2eservice";
const properties: Record<string, { type: string; data: string | number | boolean }> = {
  Id: { type: "s", data: unitName },
  LoadState: { type: "s", data: "loaded" },
  UnitFileState: { type: "s", data: "enabled" },
  RefuseManualStart: { type: "b", data: false },
  CanStart: { type: "b", data: true },
  ActiveState: { type: "s", data: "active" },
  SubState: { type: "s", data: "running" },
  StartLimitBurst: { type: "u", data: 5 },
  Result: { type: "s", data: "success" },
  NRestarts: { type: "u", data: 2 },
  MainPID: { type: "u", data: 412 },
  ExecMainStatus: { type: "i", data: 0 },
  ExecMainCode: { type: "i", data: 1 },
  KillMode: { type: "s", data: "control-group" },
  TasksCurrent: { type: "t", data: 8 },
  MemoryCurrent: { type: "t", data: 2048 },
  ControlGroup: { type: "s", data: "/user.slice/openclaw-owned.service" },
};
const stopped = {
  ActiveState: "inactive",
  SubState: "dead",
  MainPID: 0,
  TasksCurrent: Number("18446744073709551615"),
};
const readLoaded = (options: Parameters<typeof readSystemdServiceRuntime>[1] = {}) =>
  readSystemdServiceRuntime(env, { requireLoaded: true, ...options });
const reply = (type: string, ...data: unknown[]) => success(JSON.stringify({ type, data }));
const mockRuntime = (values: Record<string, string | number | boolean>) =>
  busctl.mockImplementation(async (_env, args) => managerReply(args, values));
function mockCollected(
  options: {
    missing?: boolean;
    processes?: unknown[];
    values?: Record<string, string | number | boolean>;
    beforeQuery?: (args: string[], loaded: boolean) => void;
  } = {},
) {
  const manager = { loaded: false };
  busctl.mockImplementation(async (_env, args) => {
    options.beforeQuery?.(args, manager.loaded);
    if (options.missing && args.includes("GetUnit")) {
      return failure(`Call failed: Unit ${unitName} not loaded.`);
    }
    if (args.includes("LoadUnit")) {
      manager.loaded = true;
      return reply("o", unitPath);
    }
    if (args.includes("GetProcesses")) {
      // GetProcesses belongs to Service, not Unit (systemd src/core/dbus.c).
      return options.missing && !args.includes("org.freedesktop.systemd1.Service")
        ? failure("Unknown method GetProcesses")
        : reply("a(sus)", options.processes ?? []);
    }
    return managerReply(args, options.values ?? stopped);
  });
  return manager;
}

function success(stdout: string): ExecResult {
  return { code: 0, termination: "exit", stdout, stderr: "" };
}
const failure = (stderr: string): ExecResult => ({ ...success(""), code: 1, stderr });
function managerReply(args: string[], overrides: Record<string, unknown> = {}): ExecResult {
  if (args.includes("GetNameOwner")) {
    return reply("s", ":1.42");
  }
  if (args.includes("GetConnectionUnixUser")) {
    return reply("u", 2001);
  }
  if (args.includes("GetUnit")) {
    return reply("o", unitPath);
  }
  const propertyIndex = args.findIndex((arg) => /\.(Unit|Service)$/.test(arg));
  if (propertyIndex < 0) {
    throw new Error(`Unexpected manager query: ${args.join(" ")}`);
  }
  const encode = (name: string) =>
    JSON.stringify(
      name in overrides ? { ...properties[name], data: overrides[name] } : properties[name],
    );
  const values = args.slice(propertyIndex + 1).map(encode);
  return success(values.join("\n"));
}

beforeEach(() => {
  busctl.mockReset().mockImplementation(async (_env, args) => managerReply(args));
  systemBusctl.mockReset();
  systemctl.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["masked", "masked", false, false, "masked"],
  ["loaded", "disabled", true, true, "refuse-manual-start"],
  ["loaded", "disabled", false, false, "disabled-no-start"],
] satisfies [string, string, boolean, boolean, string][])(
  "reports native start refusal (%s, %s, %s, %s, %s)",
  async (load, file, refuse, canStart, reason) => {
    const values = {
      Id: unitName,
      LoadState: load,
      UnitFileState: file,
      RefuseManualStart: refuse,
      CanStart: canStart,
      ActiveState: "inactive",
      MainPID: 0,
      TasksCurrent: 0,
    };
    mockRuntime(values);
    systemctl.mockResolvedValue(
      success(
        Object.entries(values)
          .map(
            ([key, value]) =>
              `${key}=${typeof value === "boolean" ? (value ? "yes" : "no") : value}`,
          )
          .join("\n"),
      ),
    );
    for (const requireLoaded of [true, false]) {
      const runtime = await readSystemdServiceRuntime(env, {
        requireLoaded,
        commandInspection: { kind: "present" },
      });
      expect(runtime.systemd?.startRefusal?.reason).toBe(reason);
      if (reason === "masked") {
        expect(runtime.detail).toContain(`systemctl --user unmask ${unitName}`);
      }
    }
  },
);

it.each([0, 2001])("authenticates system manager UID %s", async (uid) => {
  systemBusctl.mockImplementation(async (args) =>
    args.includes("GetConnectionUnixUser") ? reply("u", uid) : managerReply(args),
  );
  const observation = readLoaded({
    systemdReadTarget: { scope: "system", unitName, unitPath: `/etc/systemd/system/${unitName}` },
  });
  if (uid === 0) {
    const runtime = await observation;
    expect(runtime).toMatchObject({
      status: "running",
      systemd: {
        scope: "system",
        unit: unitName,
        managerUid: 0,
        controlGroup: "/user.slice/openclaw-owned.service",
      },
    });
    expect(runtime.systemd?.transport).toBeUndefined();
  } else {
    await expect(observation).rejects.toMatchObject({ reason: "systemd-manager-changed" });
  }
  expect(busctl).not.toHaveBeenCalled();
  expect(systemctl).not.toHaveBeenCalled();
  expect(
    systemBusctl.mock.calls.every(
      ([args]) => args.includes("--auto-start=no") && !args.includes("LoadUnit"),
    ),
  ).toBe(true);
});

it.each([[-1], 2001].map((uid) => ({ uid })))(
  "refuses an invalid manager UID reply $uid",
  async ({ uid }) => {
    busctl.mockImplementation(async (_env, args) =>
      args.includes("GetConnectionUnixUser")
        ? success(JSON.stringify({ type: "u", data: uid }))
        : managerReply(args),
    );
    await expect(readLoaded()).resolves.toMatchObject({
      status: "unknown",
      inspectionFailure: expect.anything(),
    });
  },
);

it.each([
  [
    "deactivating",
    { ActiveState: "deactivating", SubState: "deactivating", MainPID: 0, TasksCurrent: 0 },
  ],
  ["foreign identity", { Id: "foreign.service" }],
  ["missing load state", { LoadState: "not-found" }],
  ["malformed active state", { ActiveState: false }],
  ["invalid PID", { MainPID: -1 }],
  ["remaining PID", { ...stopped, MainPID: 412, TasksCurrent: 0 }],
  ["remaining tasks", { ...stopped, MainPID: 0, TasksCurrent: 8 }],
] satisfies [string, Record<string, string | number | boolean>][])(
  "refuses a running/stopped claim with %s",
  async (_name, values) => {
    mockRuntime(values);
    expect((await readLoaded()).status).toBe("unknown");
    expect(systemctl).not.toHaveBeenCalled();
  },
);

it.each([
  ["empty inventory", [], "stopped", false],
  ["remaining descendant", [["/unit/child", 431, "worker"]], "unknown", false],
  ["expired inventory", [], "unknown", true],
] satisfies [string, unknown[], string, boolean][])(
  "checks drainage without accounting: %s",
  async (_label, processes, expected, expired) => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    busctl.mockImplementation(async (_env, args) => {
      if (args.includes("GetUnitProcesses")) {
        elapsed = expired ? 1001 : 0;
        return reply("a(sus)", processes);
      }
      return managerReply(args, stopped);
    });
    const runtime = await readLoaded({ timeoutMs: 1000 });
    expect(runtime.status).toBe(expected);
    if (!expired) {
      expect(runtime.systemd?.tasksCurrent).toBeUndefined();
    }
    expect(busctl.mock.calls.find(([, args]) => args.includes("GetUnitProcesses"))?.[1]).toEqual([
      "--auto-start=no",
      "--json=short",
      "call",
      ":1.42",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "GetUnitProcesses",
      "s",
      unitName,
    ]);
    expect(systemctl).not.toHaveBeenCalled();
  },
);

it.each(["unowned", "owned", "uid", "busy"])(
  "checks definition-loading authority: %s",
  async (mode) => {
    const assertCurrent = vi.fn();
    const manager = mockCollected({
      missing: mode === "unowned" || mode === "owned",
      processes: mode === "busy" ? [["/owned", 91, "child"]] : [],
    });
    const observation = readLoaded(
      mode === "unowned"
        ? {}
        : { loadForInspection: { managerUid: mode === "uid" ? 2002 : 2001, assertCurrent } },
    );
    if (mode === "uid") {
      await expect(observation).rejects.toMatchObject({ reason: "systemd-manager-changed" });
    } else {
      const runtime = await observation;
      expect(runtime.status).toBe(mode === "owned" ? "stopped" : "unknown");
      if (mode !== "busy") {
        expect(runtime.missingUnit).not.toBe(true);
      }
    }
    const loaded = mode === "owned" || mode === "busy";
    expect(manager.loaded).toBe(loaded);
    expect(busctl.mock.calls.some(([, args]) => args.includes("LoadUnit"))).toBe(loaded);
    if (mode === "owned") {
      expect(assertCurrent).toHaveBeenCalled();
      expect(busctl.mock.calls.some(([, args]) => args.includes("GetProcesses"))).toBe(true);
    }
    expect(systemctl).not.toHaveBeenCalled();
    expect(
      busctl.mock.calls.every(
        ([, args]) =>
          args.includes("--auto-start=no") &&
          !args.some((arg) => /^(Start|Restart|Enable|Stop)Unit/.test(arg)),
      ),
    ).toBe(true);
  },
);

it.each(["revoked-before", "revoked-load", "revoked-read", "claim-revoked", "slow-claim"] as const)(
  "bounds failed-unit inspection: %s",
  async (mode) => {
    let now = 0;
    let active = mode !== "revoked-before";
    let claimChanged = false;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const live = () => {
      if (!active) {
        throw new Error("source/executor revoked");
      }
    };
    const inspection = {
      managerUid: 2001,
      assertCurrent() {
        // Installed artifact-preserving snapshots take about 100ms; native
        // queries take a few ms. Exact claims authorize loading, not reads.
        now += mode === "slow-claim" ? 1600 : 100;
        live();
        if (claimChanged) {
          throw new Error("exact claim changed");
        }
      },
      assertReadCurrent: live,
    };
    const manager = mockCollected({
      values: { ...stopped, ActiveState: "failed", SubState: "failed" },
      beforeQuery(args, loaded) {
        now += 5;
        if (mode === "claim-revoked" && args.includes("GetConnectionUnixUser")) {
          claimChanged = true;
        }
        if (
          (mode === "revoked-load" && args.includes("LoadUnit")) ||
          (mode === "revoked-read" && loaded && args.includes("get-property"))
        ) {
          active = false;
        }
      },
    });
    const runtime = await readLoaded({
      timeoutMs: 1500,
      loadForInspection: inspection,
    });
    expect(runtime.status).toBe(mode === "slow-claim" ? "stopped" : "unknown");
    expect(manager.loaded).toBe(!["revoked-before", "claim-revoked"].includes(mode));
    expect(systemctl).not.toHaveBeenCalled();
  },
);

it.each([
  { replaced: false, native: false, tasks: 8n, expectedTasks: 8 },
  { replaced: true, native: false, tasks: 8n, expectedTasks: 8 },
  { replaced: false, native: true, tasks: 8n, expectedTasks: 8 },
  { replaced: false, native: true, tasks: 0xffffffffffffffffn, expectedTasks: undefined },
])(
  "reads peer counters: replaced=$replaced native=$native tasks=$tasks",
  async ({ replaced, native, tasks, expectedTasks }) => {
    const binding = {
      unit: unitName,
      managerUid: 2001,
      destination: ":1.42",
      verify: vi.fn(() => {
        if (replaced) {
          throw new Error("original manager replaced");
        }
      }),
      close: vi.fn(async () => {}),
      query: vi.fn(async (args: string[]) =>
        managerReply(args, { ControlGroup: "" })
          .stdout.split("\n")
          .map((line) => {
            const row = JSON.parse(line) as { type: string; data: unknown };
            return native && row.type === "t" && typeof row.data === "number"
              ? args.includes("TasksCurrent") && row.data === 8
                ? tasks
                : BigInt(row.data)
              : row.data;
          }),
      ),
    };
    const runtime = await readSystemdServiceRuntime(
      { ...env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/unavailable-authored-bus" },
      { requireLoaded: true, timeoutMs: 1000, systemdReadBinding: binding },
    );
    expect(runtime.status).toBe(replaced ? "unknown" : "running");
    if (!replaced) {
      expect(runtime).toMatchObject({
        pid: 412,
        state: "active",
        subState: "running",
        lastExitStatus: 0,
        lastExitReason: "exited",
        systemd: {
          unit: unitName,
          managerUid: 2001,
          result: "success",
          nRestarts: 2,
          tasksCurrent: expectedTasks,
          memoryCurrent: 2048,
          controlGroup: undefined,
        },
      });
    }
    expect(busctl).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
    expect(binding.close).not.toHaveBeenCalled();
  },
);
