import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectServiceProcessMembershipSync } from "./service-process-membership.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: native.spawn,
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: native.read,
}));

const gatewayPid = process.pid + 1_000;
const groupRows = (group = 900, session = 0) =>
  `${process.pid} ${group} ${session}\n${gatewayPid} 900 ${session}\n`;
const procStat = (pid: number, group: number, comm = "synthetic worker") =>
  `${pid} (${comm}) S 1 ${group} 1 0 -1 ${Array(44).fill(0).join(" ")}\n`;
const coalition = (id: number, name: string, pid = process.pid) => `pid/${pid} = {
  type = pid
  resource coalition = {
    ID = ${id}
    type = resource
    state = active
    active count = 2
    name = ${name}
    bundle ID = example.synthetic
  }
}`;
const uncontained = (pid: number) => `pid/${pid} = {\n  type = pid\n}`;

beforeEach(() => {
  vi.resetAllMocks();
  native.spawn.mockReturnValue({ status: 1, stdout: "" });
  native.read.mockImplementation(() => {
    throw new Error("native observation unavailable");
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("launchd process membership", () => {
  const cases: Array<{
    label: string;
    caller: string;
    gateway: string;
    expected: string;
    ps?: { stdout: string; status?: number; error?: Error };
    query?: { status?: number; error?: Error };
  }> = [
    {
      label: "reparented same group",
      ps: { stdout: groupRows() },
      caller: "",
      gateway: "",
      expected: "inside",
    },
    ...[
      { label: "same coalition", callerId: 1203, callerName: "example.child", expected: "inside" },
      {
        label: "same native job",
        callerId: 1204,
        callerName: "ai.openclaw.gateway",
        expected: "inside",
      },
      {
        label: "distinct native jobs",
        callerId: 1204,
        callerName: "com.apple.Terminal",
        expected: "outside",
      },
      {
        label: "same coalition with opaque service rows",
        callerId: 1203,
        callerName: "example.child",
        expected: "inside",
        services:
          "  services = {\n    42 0 example.synthetic.worker (A)\n    43 0 example.synthetic.helper (D)\n  }",
      },
    ].map(({ label, expected, callerId, callerName, services }) => ({
      label,
      expected,
      caller: coalition(callerId, callerName).replace(/\n}$/, `\n${services ?? ""}\n}`),
      gateway: coalition(1203, "ai.openclaw.gateway", gatewayPid),
    })),
    ...[
      { label: "neither PID has a coalition", caller: false, gateway: false, expected: "absent" },
      {
        label: "only the caller has a coalition",
        caller: true,
        gateway: false,
        expected: "absent",
      },
      { label: "caller outside the known job", caller: false, gateway: true, expected: "outside" },
    ].map(({ label, expected, caller, gateway }) => ({
      label,
      expected,
      caller: caller ? coalition(1203, "ai.openclaw.gateway") : uncontained(process.pid),
      gateway: gateway
        ? coalition(1203, "ai.openclaw.gateway", gatewayPid)
        : uncontained(gatewayPid),
    })),
    ...[
      { label: "missing caller", stdout: `${gatewayPid} 900 0\n` },
      { label: "invalid group", stdout: `${process.pid} 0 0\n${gatewayPid} 900 0\n` },
      { label: "duplicate PID", stdout: groupRows() + `${process.pid} 900 0\n` },
      { label: "failed ps", stdout: groupRows(), status: 1 },
      { label: "timed out ps", stdout: groupRows(), error: new Error("timeout") },
    ].map(({ label, ...ps }) => ({
      label,
      ps,
      caller: "",
      gateway: "",
      expected: "unknown",
    })),
    ...[
      { label: "empty response", stdout: "" },
      { label: "wrong PID", stdout: uncontained(gatewayPid + 1) },
      { label: "truncated PID record", stdout: uncontained(process.pid).slice(0, -1) },
      {
        label: "wrong record type",
        stdout: uncontained(process.pid).replace("type = pid", "type = domain"),
      },
      {
        label: "malformed record",
        stdout: uncontained(process.pid).replace("type = pid", "type = pid\n  unreadable"),
      },
      {
        label: "wrong coalition type",
        stdout: coalition(1203, "ai.openclaw.gateway").replace("type = resource", "type = jetsam"),
      },
      {
        label: "duplicate coalition",
        stdout: coalition(1203, "a").replace(
          /\n}$/,
          `\n${coalition(1204, "b").split("\n").slice(2, -1).join("\n")}\n}`,
        ),
      },
      {
        label: "malformed coalition",
        stdout: uncontained(process.pid).replace(
          "type = pid",
          "type = pid\n  resource coalition = unavailable",
        ),
      },
      {
        label: "duplicate identity",
        stdout: coalition(1203, "a").replace("ID = 1203", "ID = 1203\n    ID = 1204"),
      },
      { label: "missing name", stdout: coalition(1203, "") },
      { label: "failed query", stdout: coalition(1203, "ai.openclaw.gateway"), status: 1 },
      {
        label: "truncated query",
        stdout: coalition(1203, "ai.openclaw.gateway"),
        error: new Error("maxBuffer"),
      },
    ].map(({ label, stdout, ...query }) => ({
      label,
      query,
      caller: stdout,
      gateway: stdout.replaceAll(`pid/${process.pid}`, `pid/${gatewayPid}`),
      expected: "unknown",
    })),
  ];
  it.each(cases)(
    "classifies $label from native records",
    ({ caller, gateway, ps, query, expected }) => {
      vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.gateway");
      vi.stubEnv("OPENCLAW_SERVICE_MARKER", "openclaw");
      native.spawn.mockImplementation((command: string, args: string[]) =>
        command === "ps"
          ? { status: 0, stdout: groupRows(901, 77), ...ps }
          : { status: 0, stdout: args[1] === `pid/${process.pid}` ? caller : gateway, ...query },
      );
      expect(inspectServiceProcessMembershipSync(gatewayPid, "darwin")).toBe(expected);
    },
  );
});

describe("systemd process membership", () => {
  const root = "/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service";
  const cg = `0::${root}`;
  const cases: Array<{
    label: string;
    caller?: string;
    gateway?: string;
    controlGroup?: string;
    callerStat?: string;
    gatewayStat?: string;
    expected: string;
  }> = [
    ...(
      [
        ["unit root", cg, cg, "inside"],
        ["delegated subgroup", `${cg}/workers/session.scope`, cg, "inside"],
        [
          "delegated worker.service sibling",
          `${cg}/workers/sibling`,
          `${cg}/workers/worker.service`,
          "inside",
        ],
        ["unit prefix lookalike", `${cg}-other.service`, cg, "outside"],
        ["legacy hierarchy", `1:name=systemd:${root}/worker`, `1:name=systemd:${root}`, "inside"],
        [
          "hybrid hierarchy",
          `0::/\n1:name=systemd:${root}/worker`,
          `0::/\n1:name=systemd:${root}`,
          "inside",
        ],
        ["caller root hierarchy", "0::/", cg, "outside"],
        ["unmanaged Gateway", cg, "0::/", "unknown"],
        [
          "conflicting authorities",
          `1:name=systemd:${root}\n2:name=systemd:/other.service`,
          cg,
          "unknown",
        ],
        ["incomparable v1 and v2 paths", "1:name=systemd:/outside.service", cg, "unknown"],
        [
          "different named hierarchy identities",
          "1:name=systemd:/outside.service",
          `2:name=systemd:${root}`,
          "unknown",
        ],
        ["path traversal", `${cg}/../outside`, cg, "unknown"],
        ["malformed output", "unavailable", cg, "unknown"],
      ] satisfies Array<[string, string, string, string]>
    ).map(([label, caller, gateway, expected]) => ({
      label,
      caller,
      gateway,
      expected,
      controlGroup: root,
    })),
    ...[
      { label: "missing", controlGroup: undefined },
      { label: "relative", controlGroup: "openclaw-gateway.service" },
      { label: "path traversal", controlGroup: `${root}/../other.service` },
      { label: "prefix lookalike", controlGroup: `${root}-other.service` },
    ].map(({ label, controlGroup }) => ({
      label,
      controlGroup,
      caller: "0::/user.slice/session-5.scope",
      gateway: cg,
      expected: "unknown",
    })),
    ...(
      [
        ["unified namespace root", "0::/", "0::/", "absent", undefined],
        ["observed root ControlGroup", "0::/", "0::/", "absent", "/"],
        [
          "legacy systemd hierarchy root",
          "1:name=systemd:/",
          "1:name=systemd:/",
          "absent",
          undefined,
        ],
        [
          "valid v1 without systemd",
          "2:cpu,cpuacct:/caller\n3:memory:/caller",
          "2:cpu,cpuacct:/\n3:memory:/",
          "absent",
          undefined,
        ],
        [
          "non-root v1 without systemd",
          "2:cpu,cpuacct:/caller\n3:memory:/caller",
          "2:cpu,cpuacct:/gateway\n3:memory:/",
          "unknown",
          undefined,
        ],
        ["unobserved non-root unit", "0::/", cg, "unknown", undefined],
        ["empty proc response", "", "", "unknown", undefined],
        ["malformed v1 row", "2:cpu:/\nunreadable", "2:cpu:/", "unknown", undefined],
        ["duplicate hierarchy", "0::/\n0::/", "0::/", "unknown", undefined],
        ["invalid v1 controller", "2::/", "2::/", "unknown", undefined],
        ["mismatched hierarchy", "0::/", "1:name=systemd:/", "unknown", undefined],
        ["denied caller proc", undefined, "0::/", "unknown", undefined],
        ["vanished Gateway proc", "0::/", undefined, "unknown", undefined],
      ] satisfies Array<
        [string, string | undefined, string | undefined, string, string | undefined]
      >
    ).map(([label, caller, gateway, expected, controlGroup]) => ({
      label,
      caller,
      gateway,
      expected,
      controlGroup,
      callerStat: procStat(process.pid, 901),
      gatewayStat: procStat(gatewayPid, 900),
    })),
    ...(
      [
        ["reparented same group", procStat(process.pid, 900), "inside", undefined],
        ["distinct groups without ps", procStat(process.pid, 901), "absent", undefined],
        [
          "command with parentheses and newline",
          procStat(process.pid, 901, "worker ) (child\nprocess)"),
          "absent",
          undefined,
        ],
        ["wrong PID", procStat(gatewayPid, 901), "unknown", undefined],
        ["zero group", procStat(process.pid, 0), "unknown", undefined],
        ["unsafe group", procStat(process.pid, Number.MAX_SAFE_INTEGER + 1), "unknown", undefined],
        ["unreadable caller", undefined, "unknown", undefined],
        ["vanished Gateway", procStat(process.pid, 901), "unknown", true],
      ] satisfies Array<[string, string | undefined, string, boolean | undefined]>
    ).map(([label, callerStat, expected, missingGateway]) => ({
      label,
      callerStat,
      expected,
      gatewayStat: missingGateway ? undefined : procStat(gatewayPid, 900),
      caller: "0::/",
      gateway: "0::/",
    })),
  ];
  it.each(cases)(
    "classifies $label from native membership",
    ({ caller, gateway, controlGroup, callerStat, gatewayStat, expected }) => {
      vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "unrelated.service");
      const files = new Map([
        [`/proc/${process.pid}/cgroup`, caller],
        [`/proc/${gatewayPid}/cgroup`, gateway],
        [`/proc/${process.pid}/stat`, callerStat],
        [`/proc/${gatewayPid}/stat`, gatewayStat],
      ]);
      native.read.mockImplementation((file: string) => {
        const value = files.get(file);
        if (value === undefined) {
          throw new Error("native observation unavailable");
        }
        return value;
      });
      expect(inspectServiceProcessMembershipSync(gatewayPid, "linux", controlGroup)).toBe(expected);
    },
  );
});

it("does not invent Windows Job membership from environment hints", () => {
  vi.stubEnv("OPENCLAW_WINDOWS_TASK_NAME", "OpenClaw Gateway");
  expect(inspectServiceProcessMembershipSync(gatewayPid, "win32")).toBe("unknown");
});
