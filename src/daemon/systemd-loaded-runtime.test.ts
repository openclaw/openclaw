// Update runtime observation must not load units while discovering their state.
import * as fsSync from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));

import { inspectServiceProcessMembershipSync } from "./service-process-membership.js";
import { readSystemdServiceRuntime } from "./systemd-runtime.js";

const env = {
  HOME: "/test/owned",
  OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
  OPENCLAW_PROFILE: "owned",
};
const unitName = "openclaw-owned.service";
const unitPath = "/org/freedesktop/systemd1/unit/openclaw_2downed_2eservice";
const properties = {
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

function success(stdout: string): ExecResult {
  return { code: 0, termination: "exit", stdout, stderr: "" };
}
function managerReply(args: string[], overrides: Record<string, unknown> = {}): ExecResult {
  if (args.includes("GetNameOwner")) {
    return success(JSON.stringify({ type: "s", data: [":1.42"] }));
  }
  if (args.includes("GetConnectionUnixUser")) {
    return success(JSON.stringify({ type: "u", data: [2001] }));
  }
  if (args.includes("GetUnit")) {
    return success(JSON.stringify({ type: "o", data: [unitPath] }));
  }
  const propertyIndex = args.findIndex((arg) => /\.(Unit|Service)$/.test(arg));
  const values: Record<string, unknown> = { ...properties, ...overrides };
  if (propertyIndex < 0) {
    throw new Error(`Unexpected manager query: ${args.join(" ")}`);
  }
  return success(
    args
      .slice(propertyIndex + 1)
      .map((name) => JSON.stringify(values[name]))
      .join("\n"),
  );
}

beforeEach(() => {
  busctl.mockReset().mockImplementation(async (_env, args) => managerReply(args));
  systemBusctl
    .mockReset()
    .mockImplementation(async (args) =>
      args.includes("GetConnectionUnixUser")
        ? success(JSON.stringify({ type: "u", data: [0] }))
        : managerReply(args),
    );
  systemctl
    .mockReset()
    .mockResolvedValue(success("Id=openclaw-owned.service\nLoadState=loaded\nActiveState=active"));
});

describe("loaded-only systemd runtime", () => {
  it.each([
    { load: "masked", file: "masked", refuse: false, canStart: false, reason: "masked" },
    {
      load: "loaded",
      file: "disabled",
      refuse: true,
      canStart: true,
      reason: "refuse-manual-start",
    },
    {
      load: "loaded",
      file: "disabled",
      refuse: false,
      canStart: false,
      reason: "disabled-no-start",
    },
  ])("preserves native start refusal diagnostics ($file, $reason)", async (row) => {
    busctl.mockImplementation(async (_env, args) =>
      managerReply(args, {
        LoadState: { type: "s", data: row.load },
        UnitFileState: { type: "s", data: row.file },
        RefuseManualStart: { type: "b", data: row.refuse },
        CanStart: { type: "b", data: row.canStart },
        ActiveState: { type: "s", data: "inactive" },
        MainPID: { type: "u", data: 0 },
        TasksCurrent: { type: "t", data: 0 },
      }),
    );
    systemctl.mockResolvedValue(
      success(
        [
          `Id=${unitName}`,
          `LoadState=${row.load}`,
          `UnitFileState=${row.file}`,
          `RefuseManualStart=${row.refuse ? "yes" : "no"}`,
          `CanStart=${row.canStart ? "yes" : "no"}`,
          "ActiveState=inactive",
          "MainPID=0",
          "TasksCurrent=0",
        ].join("\n"),
      ),
    );
    for (const requireLoaded of [true, false]) {
      const runtime = await readSystemdServiceRuntime(env, {
        requireLoaded,
        commandInspection: { kind: "present" },
      });
      expect(runtime.systemd?.startRefusal?.reason).toBe(row.reason);
      if (row.reason === "masked") {
        expect(runtime.detail).toContain(`systemctl --user unmask ${unitName}`);
      }
    }
  });

  it.each([0, 2001])("authenticates the selected system manager UID %s", async (uid) => {
    systemBusctl.mockImplementation(async (args) =>
      args.includes("GetConnectionUnixUser")
        ? success(JSON.stringify({ type: "u", data: [uid] }))
        : managerReply(args),
    );
    const observation = readSystemdServiceRuntime(env, {
      requireLoaded: true,
      systemdReadTarget: { scope: "system", unitName, unitPath: `/etc/systemd/system/${unitName}` },
    });
    if (uid === 0) {
      const runtime = await observation;
      expect(runtime).toMatchObject({
        status: "running",
        systemd: { scope: "system", unit: unitName, managerUid: 0 },
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

  it("reads the owned loaded unit without systemctl show or unit activation", async () => {
    const runtime = await readSystemdServiceRuntime(env, { requireLoaded: true, timeoutMs: 1000 });
    expect(runtime).toMatchObject({
      status: "running",
      pid: 412,
      state: "active",
      subState: "running",
      lastExitStatus: 0,
      lastExitReason: "exited",
      systemd: {
        unit: unitName,
        result: "success",
        nRestarts: 2,
        tasksCurrent: 8,
        memoryCurrent: 2048,
        controlGroup: "/user.slice/openclaw-owned.service",
      },
    });
    expect(systemctl).not.toHaveBeenCalled();
    expect(
      busctl.mock.calls.every(
        ([selected, args]) =>
          selected === env && args.includes("--auto-start=no") && !args.includes("LoadUnit"),
      ),
    ).toBe(true);
    const pinned = busctl.mock.calls.filter(([, args]) => !args.includes("GetNameOwner"));
    expect(pinned).toHaveLength(4);
    expect(pinned.every(([, args]) => args.includes(":1.42"))).toBe(true);
  });

  it.each(["bus"])(
    "does not infer absent containment from empty %s metadata over a non-root cgroup",
    async (transport) => {
      busctl.mockImplementation(async (_env, args) =>
        managerReply(args, { ControlGroup: { type: "s", data: "" } }),
      );
      systemctl.mockResolvedValue(
        success(`Id=${unitName}\nLoadState=loaded\nActiveState=active\nMainPID=412\nControlGroup=`),
      );
      const read = fsSync.readFileSync;
      const observation = vi.spyOn(fsSync, "readFileSync").mockImplementation((file, options) => {
        if (file === `/proc/${process.pid}/cgroup` || file === "/proc/412/cgroup") {
          return "0::/container.scope\n";
        }
        if (file === `/proc/${process.pid}/stat`) {
          return `${process.pid} (caller) S 1 901\n`;
        }
        if (file === "/proc/412/stat") {
          return "412 (gateway) S 1 900\n";
        }
        return read(file, options);
      });
      try {
        const runtime = await readSystemdServiceRuntime(env, {
          requireLoaded: transport === "bus",
          commandInspection: { kind: "present" },
        });
        expect(runtime).toMatchObject({ status: "running", pid: 412 });
        expect(
          inspectServiceProcessMembershipSync(runtime.pid!, "linux", runtime.systemd?.controlGroup),
        ).toBe("unknown");
      } finally {
        observation.mockRestore();
      }
    },
  );

  it.each([[-1], 2001].map((uid) => ({ uid })))(
    "refuses an invalid manager UID reply $uid",
    async ({ uid }) => {
      busctl.mockImplementation(async (_env, args) =>
        args.includes("GetConnectionUnixUser")
          ? success(JSON.stringify({ type: "u", data: uid }))
          : managerReply(args),
      );
      await expect(readSystemdServiceRuntime(env, { requireLoaded: true })).resolves.toMatchObject({
        status: "unknown",
        inspectionFailure: expect.anything(),
      });
    },
  );

  it.each(["deactivating"])("preserves terminal versus transitional state %s", async (state) => {
    busctl.mockImplementation(async (_env, args) =>
      managerReply(args, {
        ActiveState: { type: "s", data: state },
        SubState: { type: "s", data: state === "inactive" ? "dead" : state },
        MainPID: { type: "u", data: 0 },
        TasksCurrent: { type: "t", data: 0 },
      }),
    );
    expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe(
      state === "inactive" || state === "failed" ? "stopped" : "unknown",
    );
    expect(systemctl).not.toHaveBeenCalled();
  });

  it.each([
    { Id: { type: "s", data: "foreign.service" } },
    { LoadState: { type: "s", data: "not-found" } },
    { ActiveState: { type: "s", data: false } },
    { MainPID: { type: "u", data: -1 } },
  ])("refuses malformed or changed native identity %j", async (overrides) => {
    busctl.mockImplementation(async (_env, args) => managerReply(args, overrides));
    expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe("unknown");
    expect(systemctl).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty inventory", data: [[]], expected: "stopped" },
    {
      label: "remaining descendant",
      data: [[["/unit/child", 431, "worker"]]],
      expected: "unknown",
    },
  ])(
    "checks native process drainage when accounting is unavailable: $label",
    async ({ data, expected }) => {
      busctl.mockImplementation(async (_env, args) => {
        if (args.includes("GetUnitProcesses")) {
          return data === null
            ? { code: 1, termination: "exit", stdout: "", stderr: "Access denied" }
            : success(JSON.stringify({ type: "a(sus)", data }));
        }
        return managerReply(args, {
          ActiveState: { type: "s", data: "inactive" },
          SubState: { type: "s", data: "dead" },
          MainPID: { type: "u", data: 0 },
          TasksCurrent: { type: "t", data: Number("18446744073709551615") },
        });
      });
      const runtime = await readSystemdServiceRuntime(env, { requireLoaded: true });
      expect(runtime.status).toBe(expected);
      expect(runtime.systemd?.tasksCurrent).toBeUndefined();
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

  it("rejects inventory after its deadline", async () => {
    let enumerated = false;
    let elapsed = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    busctl.mockImplementation(async (_env, args) => {
      if (args.includes("GetUnitProcesses")) {
        enumerated = true;
        elapsed = 1001;
        return success(JSON.stringify({ type: "a(sus)", data: [[]] }));
      }
      return managerReply(args, {
        ActiveState: { type: "s", data: "inactive" },
        SubState: { type: "s", data: "dead" },
        MainPID: { type: "u", data: 0 },
        TasksCurrent: { type: "t", data: Number("18446744073709551615") },
      });
    });
    try {
      const observation = readSystemdServiceRuntime(env, {
        requireLoaded: true,
        timeoutMs: 1000,
      });
      expect((await observation).status).toBe("unknown");
      expect(enumerated).toBe(true);
      expect(systemctl).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { pid: 412, tasks: 0 },
    { pid: 0, tasks: 8 },
  ])("refuses a stopped claim without drained native processes %j", async ({ pid, tasks }) => {
    busctl.mockImplementation(async (_env, args) =>
      managerReply(args, {
        ActiveState: { type: "s", data: "inactive" },
        SubState: { type: "s", data: "dead" },
        MainPID: { type: "u", data: pid },
        TasksCurrent: { type: "t", data: tasks },
      }),
    );
    expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe("unknown");
    expect(systemctl).not.toHaveBeenCalled();
  });
});

describe("owned recovery inspection of collected systemd units", () => {
  it.each([false, true])(
    "requires fresh authority to inspect an unloaded definition (owned=%s)",
    async (owned) => {
      const assertCurrent = vi.fn();
      busctl.mockImplementation(async (_env, args) => {
        if (args.includes("GetUnit")) {
          return {
            code: 1,
            termination: "exit",
            stdout: "",
            stderr: `Call failed: Unit ${unitName} not loaded.`,
          };
        }
        if (args.includes("LoadUnit")) {
          return success(JSON.stringify({ type: "o", data: [unitPath] }));
        }
        if (args.includes("GetProcesses")) {
          // systemd registers the cgroup methods on the type-specific Service
          // interface, not the generic Unit interface (src/core/dbus.c).
          if (!args.includes("org.freedesktop.systemd1.Service")) {
            return {
              code: 1,
              termination: "exit",
              stdout: "",
              stderr: "Unknown method GetProcesses",
            };
          }
          return success(JSON.stringify({ type: "a(sus)", data: [[]] }));
        }
        return managerReply(args, {
          ActiveState: { type: "s", data: "inactive" },
          SubState: { type: "s", data: "dead" },
          MainPID: { type: "u", data: 0 },
          TasksCurrent: { type: "t", data: Number("18446744073709551615") },
        });
      });
      const opts = {
        requireLoaded: true,
        ...(owned ? { loadForInspection: { managerUid: 2001, assertCurrent } } : {}),
      };
      const runtime = await readSystemdServiceRuntime(env, opts);
      expect(runtime.status).toBe(owned ? "stopped" : "unknown");
      expect(runtime.missingUnit).not.toBe(true);
      if (owned) {
        expect(assertCurrent).toHaveBeenCalled();
        expect(busctl.mock.calls.some(([, args]) => args.includes("GetProcesses"))).toBe(true);
      }
      expect(busctl.mock.calls.some(([, args]) => args.includes("LoadUnit"))).toBe(owned);
      expect(systemctl).not.toHaveBeenCalled();
    },
  );
});

describe("owned inspection refuses foreign or unverified collected units", () => {
  it.each(["uid", "busy"] as const)(
    "preserves the %s refusal without enabling or starting anything",
    async (fault) => {
      let loaded = false;
      const assertCurrent = () => {};
      busctl.mockImplementation(async (_env, args) => {
        if (args.includes("LoadUnit")) {
          loaded = true;
          return success(JSON.stringify({ type: "o", data: [unitPath] }));
        }
        if (args.includes("GetProcesses")) {
          return success(
            JSON.stringify({
              type: "a(sus)",
              data: [fault === "busy" ? [["/owned", 91, "child"]] : []],
            }),
          );
        }
        return managerReply(args, {
          ActiveState: { type: "s", data: "inactive" },
          SubState: { type: "s", data: "dead" },
          MainPID: { type: "u", data: 0 },
          TasksCurrent: { type: "t", data: Number("18446744073709551615") },
        });
      });
      const observation = readSystemdServiceRuntime(env, {
        requireLoaded: true,
        loadForInspection: { managerUid: fault === "uid" ? 2002 : 2001, assertCurrent },
      });
      if (fault === "uid") {
        await expect(observation).rejects.toMatchObject({ reason: "systemd-manager-changed" });
      } else {
        expect((await observation).status).toBe("unknown");
      }
      expect(loaded).toBe(fault !== "uid");
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
});

describe("bounded owned runtime inspection", () => {
  it.each([
    "revoked-before",
    "revoked-load",
    "revoked-read",
    "claim-revoked",
    "slow-claim",
  ] as const)(
    "keeps %s authority while collecting a failed unit within the remaining budget",
    async (mode) => {
      let now = 0;
      let active = mode !== "revoked-before";
      let loaded = false;
      let claimChanged = false;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
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
      busctl.mockImplementation(async (_env, args) => {
        now += 5;
        if (mode === "claim-revoked" && args.includes("GetConnectionUnixUser")) {
          claimChanged = true;
        }
        if (args.includes("LoadUnit")) {
          loaded = true;
          if (mode === "revoked-load") {
            active = false;
          }
          return success(JSON.stringify({ type: "o", data: [unitPath] }));
        }
        if (mode === "revoked-read" && loaded && args.includes("get-property")) {
          active = false;
        }
        if (args.includes("GetProcesses")) {
          return success(JSON.stringify({ type: "a(sus)", data: [[]] }));
        }
        return managerReply(args, {
          ActiveState: { type: "s", data: "failed" },
          SubState: { type: "s", data: "failed" },
          MainPID: { type: "u", data: 0 },
          TasksCurrent: { type: "t", data: Number("18446744073709551615") },
        });
      });
      try {
        const runtime = await readSystemdServiceRuntime(env, {
          requireLoaded: true,
          timeoutMs: 1500,
          loadForInspection: inspection,
        });
        expect(runtime.status).toBe(mode === "slow-claim" ? "stopped" : "unknown");
        expect(loaded).toBe(!["revoked-before", "claim-revoked"].includes(mode));
        expect(systemctl).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );
});

describe("retained original-manager transport", () => {
  it.each([false, true])(
    "reads through the retained peer and rejects replacement=%s without another bus lookup",
    async (replaced) => {
      busctl.mockResolvedValue({
        code: 1,
        termination: "exit",
        stdout: "",
        stderr: "Failed to connect to bus",
      });
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
          managerReply(args)
            .stdout.split("\n")
            .map((line) => JSON.parse(line).data as unknown),
        ),
      };
      const runtime = await readSystemdServiceRuntime(
        { ...env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/unavailable-authored-bus" },
        { requireLoaded: true, timeoutMs: 1000, systemdReadBinding: binding },
      );
      expect(runtime.status).toBe(replaced ? "unknown" : "running");
      if (!replaced) {
        expect(runtime.systemd).toMatchObject({ unit: unitName, managerUid: 2001 });
      }
      expect(busctl).not.toHaveBeenCalled();
      expect(systemctl).not.toHaveBeenCalled();
      expect(binding.close).not.toHaveBeenCalled();
    },
  );
});
