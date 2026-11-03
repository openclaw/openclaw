import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectServiceProcessMembershipSync } from "./service-process-membership.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn(), coalition: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: native.spawn,
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  readFileSync: native.read,
}));

vi.mock("@openclaw/proc-safe/darwin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/darwin")>()),
  readProcessCoalition: native.coalition,
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
    name = ${name}
  }
}`;
const uncontained = (pid: number) => `pid/${pid} = {\n  type = pid\n}`;
type QueryFailure = { status?: number; error?: Error };
type PsResult = QueryFailure & { stdout: string };

beforeEach(() => {
  vi.resetAllMocks();
  native.spawn.mockReturnValue({ status: 1, stdout: "" });
  native.coalition.mockImplementation(() => {
    throw new Error("unavailable");
  });
  native.read.mockImplementation(() => {
    throw new Error("native observation unavailable");
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("launchd process membership", () => {
  const pidRecord = uncontained(process.pid);
  const jobRecord = coalition(1203, "ai.openclaw.gateway");
  const malformedPid = (body: string) => pidRecord.replace("type = pid", body);
  type RecordCase = [string, string, string, string, PsResult?, QueryFailure?];
  const jobCase = (label: string, caller: string, expected: string): RecordCase => [
    label,
    caller,
    coalition(1203, "ai.openclaw.gateway", gatewayPid),
    expected,
  ];
  const cases: RecordCase[] = [
    ["reparented same group", "", "", "inside", { stdout: groupRows() }],
    jobCase("same coalition", coalition(1203, "example.child"), "inside"),
    jobCase("same native job", coalition(1204, "ai.openclaw.gateway"), "inside"),
    jobCase("distinct native jobs", coalition(1204, "com.apple.Terminal"), "outside"),
    jobCase(
      "same coalition with opaque service rows",
      coalition(1203, "example.child").replace(
        /\n}$/,
        "\n  services = {\n    42 0 example.synthetic.worker (A)\n    43 0 example.synthetic.helper (D)\n  }\n}",
      ),
      "inside",
    ),
    ["neither PID has a coalition", pidRecord, uncontained(gatewayPid), "absent"],
    ["only the caller has a coalition", jobRecord, uncontained(gatewayPid), "absent"],
    jobCase("caller outside the known job", pidRecord, "outside"),
    ...[
      { label: "missing caller", stdout: `${gatewayPid} 900 0\n` },
      { label: "invalid group", stdout: `${process.pid} 0 0\n${gatewayPid} 900 0\n` },
      { label: "duplicate PID", stdout: groupRows() + `${process.pid} 900 0\n` },
      { label: "failed ps", stdout: groupRows(), status: 1 },
      { label: "timed out ps", stdout: groupRows(), error: new Error("timeout") },
    ].map(({ label, ...ps }): RecordCase => [label, "", "", "unknown", ps]),
    ...(
      [
        ["empty response", ""],
        ["wrong PID", uncontained(gatewayPid + 1)],
        ["truncated PID record", pidRecord.slice(0, -1)],
        ["wrong record type", malformedPid("type = domain")],
        ["malformed record", malformedPid("type = pid\n  unreadable")],
        ["wrong coalition type", jobRecord.replace("type = resource", "type = jetsam")],
        [
          "duplicate coalition",
          coalition(1203, "a").replace(
            /\n}$/,
            `\n${coalition(1204, "b").split("\n").slice(2, -1).join("\n")}\n}`,
          ),
        ],
        ["malformed coalition", malformedPid("type = pid\n  resource coalition = unavailable")],
        [
          "duplicate identity",
          coalition(1203, "a").replace("ID = 1203", "ID = 1203\n    ID = 1204"),
        ],
        ["missing name", coalition(1203, "")],
        ["failed query", jobRecord, { status: 1 }],
        ["truncated query", jobRecord, { error: new Error("maxBuffer") }],
      ] satisfies Array<[string, string, QueryFailure?]>
    ).map(([label, stdout, query]): RecordCase => [
      label,
      stdout,
      stdout.replaceAll(`pid/${process.pid}`, `pid/${gatewayPid}`),
      "unknown",
      undefined,
      query,
    ]),
  ];
  it.each(cases)(
    "classifies %s from native records",
    (_label, caller, gateway, expected, ps, query) => {
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

describe("launchd process membership when launchctl denies PID domains", () => {
  // macOS 12 answers `launchctl print pid/<pid>` with exit 1 (EPERM) for most processes.
  const denied = {
    status: 1,
    stdout: "",
    stderr: "Could not print domain: 1: Operation not permitted",
  };
  const nativeRow = (id: number, name?: string) => ({ id: BigInt(id), name });
  const observe = (caller: object | null, gateway: object | null, launchctl: object = denied) => {
    native.spawn.mockImplementation((command: string) =>
      command === "ps" ? { status: 0, stdout: groupRows(901) } : launchctl,
    );
    native.coalition.mockImplementation((pid: number) => {
      const value = pid === process.pid ? caller : gateway;
      if (value instanceof Error) {
        throw value;
      }
      return value;
    });
  };

  it.each([
    ["an external terminal", nativeRow(1204, "com.apple.Terminal"), "outside"],
    ["a process in the Gateway coalition", nativeRow(1203), "inside", nativeRow(1203)],
    ["a child of an earlier Gateway instance", nativeRow(1204, "ai.openclaw.gateway"), "inside"],
    ["distinct coalitions without job names", nativeRow(1204), "unknown"],
    ["an unavailable native probe", new Error("unavailable"), "unknown"],
    ["an invalid coalition ID", nativeRow(0, "com.apple.Terminal"), "unknown"],
    ["a denied native query", new Error("access denied"), "unknown"],
  ] satisfies Array<[string, object, string, object?]>)(
    "classifies %s from native coalitions",
    (_label, caller, expected, gateway = nativeRow(1203, "ai.openclaw.gateway")) => {
      observe(caller, gateway);
      expect(inspectServiceProcessMembershipSync(gatewayPid, "darwin")).toBe(expected);
    },
  );

  it("does not query natively when launchctl itself fails to run", () => {
    observe(nativeRow(1204, "com.apple.Terminal"), nativeRow(1203, "ai.openclaw.gateway"), {
      status: null,
      stdout: "",
      error: new Error("timeout"),
    });
    expect(inspectServiceProcessMembershipSync(gatewayPid, "darwin")).toBe("unknown");
    expect(native.coalition).not.toHaveBeenCalled();
  });
});

describe("systemd process membership", () => {
  const root = "/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service";
  const cg = `0::${root}`;
  const workers = `${cg}/workers`;
  const v1 = `1:name=systemd:${root}`;
  const hybrid = `0::/\n${v1}`;
  const other = "1:name=systemd:/outside.service";
  type ProcText = string | undefined;
  type ProcStats = { callerStat?: string; gatewayStat?: string };
  type Case = [string, ProcText, ProcText, string];
  const rootStats = {
    callerStat: procStat(process.pid, 901),
    gatewayStat: procStat(gatewayPid, 900),
  };
  function check(
    caller: ProcText,
    gateway: ProcText,
    expected: string,
    controlGroup?: string,
    stats: ProcStats = {},
  ) {
    vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "unrelated.service");
    const files = new Map([
      [`/proc/${process.pid}/cgroup`, caller],
      [`/proc/${gatewayPid}/cgroup`, gateway],
      [`/proc/${process.pid}/stat`, stats.callerStat],
      [`/proc/${gatewayPid}/stat`, stats.gatewayStat],
    ]);
    native.read.mockImplementation((file: string) => {
      const value = files.get(file);
      if (value === undefined) {
        throw new Error("native observation unavailable");
      }
      return value;
    });
    expect(inspectServiceProcessMembershipSync(gatewayPid, "linux", controlGroup)).toBe(expected);
  }
  it.each([
    ["unit root", cg, cg, "inside"],
    ["delegated subgroup", `${workers}/session.scope`, cg, "inside"],
    [
      "delegated worker.service sibling",
      `${workers}/sibling`,
      `${workers}/worker.service`,
      "inside",
    ],
    ["unit prefix lookalike", `${cg}-other.service`, cg, "outside"],
    ["legacy hierarchy", `${v1}/worker`, v1, "inside"],
    ["hybrid hierarchy", `${hybrid}/worker`, hybrid, "inside"],
    ["caller root hierarchy", "0::/", cg, "outside"],
    ["unmanaged Gateway", cg, "0::/", "unknown"],
    ["conflicting authorities", `${v1}\n2:name=systemd:/other.service`, cg, "unknown"],
    ["incomparable v1 and v2 paths", other, cg, "unknown"],
    ["different named hierarchy identities", other, `2:name=systemd:${root}`, "unknown"],
    ["path traversal", `${cg}/../outside`, cg, "unknown"],
    ["malformed output", "unavailable", cg, "unknown"],
  ] satisfies Case[])(
    "classifies %s against the observed unit",
    (_label, caller, gateway, expected) => {
      check(caller, gateway, expected, root);
    },
  );
  it.each([
    ["missing", undefined],
    ["relative", "openclaw-gateway.service"],
    ["path traversal", `${root}/../other.service`],
    ["prefix lookalike", `${root}-other.service`],
  ])("rejects %s ControlGroup", (_label, controlGroup) => {
    check("0::/user.slice/session-5.scope", cg, "unknown", controlGroup);
  });
  it.each([
    ["unified namespace root", "0::/", "0::/", "absent"],
    ["observed root ControlGroup", "0::/", "0::/", "absent", "/"],
    ["legacy systemd hierarchy root", "1:name=systemd:/", "1:name=systemd:/", "absent"],
    [
      "valid v1 without systemd",
      "2:cpu,cpuacct:/caller\n3:memory:/caller",
      "2:cpu,cpuacct:/\n3:memory:/",
      "absent",
    ],
    [
      "non-root v1 without systemd",
      "2:cpu,cpuacct:/caller\n3:memory:/caller",
      "2:cpu,cpuacct:/gateway\n3:memory:/",
      "unknown",
    ],
    ["unobserved non-root unit", "0::/", cg, "unknown"],
    ["empty proc response", "", "", "unknown"],
    ["malformed v1 row", "2:cpu:/\nunreadable", "2:cpu:/", "unknown"],
    ["duplicate hierarchy", "0::/\n0::/", "0::/", "unknown"],
    ["invalid v1 controller", "2::/", "2::/", "unknown"],
    ["mismatched hierarchy", "0::/", "1:name=systemd:/", "unknown"],
    ["denied caller proc", undefined, "0::/", "unknown"],
    ["vanished Gateway proc", "0::/", undefined, "unknown"],
  ] satisfies Array<[...Case, string?]>)(
    "classifies %s without unit containment",
    (_label, caller, gateway, expected, controlGroup?: string) => {
      check(caller, gateway, expected, controlGroup, rootStats);
    },
  );
  it.each([
    ["reparented same group", procStat(process.pid, 900), "inside"],
    ["distinct groups without ps", procStat(process.pid, 901), "absent"],
    [
      "command with parentheses and newline",
      procStat(process.pid, 901, "worker ) (child\nprocess)"),
      "absent",
    ],
    ["wrong PID", procStat(gatewayPid, 901), "unknown"],
    ["zero group", procStat(process.pid, 0), "unknown"],
    ["unsafe group", procStat(process.pid, Number.MAX_SAFE_INTEGER + 1), "unknown"],
    ["unreadable caller", undefined, "unknown"],
    ["vanished Gateway", procStat(process.pid, 901), "unknown", true],
  ] satisfies Array<[string, ProcText, string, boolean?]>)(
    "classifies %s by process group",
    (_label, callerStat, expected, missingGateway?: boolean) => {
      check("0::/", "0::/", expected, undefined, {
        callerStat,
        gatewayStat: missingGateway ? undefined : procStat(gatewayPid, 900),
      });
    },
  );
});

it("does not invent Windows Job membership from environment hints", () => {
  vi.stubEnv("OPENCLAW_WINDOWS_TASK_NAME", "OpenClaw Gateway");
  expect(inspectServiceProcessMembershipSync(gatewayPid, "win32")).toBe("unknown");
});
