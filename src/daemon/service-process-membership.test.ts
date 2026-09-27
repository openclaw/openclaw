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
const coalition = (id: number, name: string) => `pid/123 = {
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

beforeEach(() => {
  vi.resetAllMocks();
  native.spawn.mockReturnValue({ status: 1, stdout: "" });
  native.read.mockImplementation(() => {
    throw new Error("native observation unavailable");
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("launchd process membership", () => {
  it("recognizes a reparented process in the Gateway process group without a coalition query", () => {
    native.spawn.mockImplementation((command: string) =>
      command === "ps" ? { status: 0, stdout: groupRows() } : { status: 1, stdout: "" },
    );
    expect(inspectServiceProcessMembershipSync(gatewayPid, "darwin")).toBe("inside");
  });

  it.each([
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
  ])(
    "uses $label after detached process groups, even with a shared session",
    ({ callerId, callerName, expected }) => {
      vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.gateway");
      vi.stubEnv("OPENCLAW_SERVICE_MARKER", "openclaw");
      native.spawn.mockImplementation((command: string, args: string[]) => ({
        status: 0,
        stdout:
          command === "ps"
            ? groupRows(901, 77)
            : args[1] === `pid/${process.pid}`
              ? coalition(callerId, callerName)
              : coalition(1203, "ai.openclaw.gateway"),
      }));
      expect(inspectServiceProcessMembershipSync(gatewayPid, "darwin")).toBe(expected);
    },
  );

  it.each([
    { label: "missing caller", stdout: `${gatewayPid} 900 0\n` },
    { label: "invalid group", stdout: `${process.pid} 0 0\n${gatewayPid} 900 0\n` },
    { label: "duplicate PID", stdout: groupRows() + `${process.pid} 900 0\n` },
    { label: "failed ps", stdout: groupRows(), status: 1 },
    { label: "timed out ps", stdout: groupRows(), error: new Error("timeout") },
  ])("keeps $label evidence unknown", ({ stdout, ...result }) => {
    native.spawn.mockReturnValue({ status: 0, stdout, ...result });
    expect(inspectServiceProcessMembershipSync(gatewayPid, "darwin")).toBe("unknown");
  });

  it.each([
    { label: "missing block", stdout: "pid/123 = { type = pid }" },
    {
      label: "wrong coalition type",
      stdout: coalition(1203, "ai.openclaw.gateway").replace("type = resource", "type = jetsam"),
    },
    { label: "duplicate coalition", stdout: coalition(1203, "a") + coalition(1204, "b") },
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
  ])("does not treat $label as proof of escape", ({ stdout, ...result }) => {
    native.spawn.mockImplementation((command: string) =>
      command === "ps" ? { status: 0, stdout: groupRows(901) } : { status: 0, stdout, ...result },
    );
    expect(inspectServiceProcessMembershipSync(gatewayPid, "darwin")).toBe("unknown");
  });
});

describe("systemd process membership", () => {
  const root = "/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service";
  it.each([
    { label: "unit root", caller: `0::${root}`, gateway: `0::${root}`, expected: "inside" },
    {
      label: "delegated subgroup",
      caller: `0::${root}/workers/session.scope`,
      gateway: `0::${root}`,
      expected: "inside",
    },
    {
      label: "different subgroup",
      caller: `0::${root}/workers/a`,
      gateway: `0::${root}/workers/b`,
      expected: "inside",
    },
    {
      label: "delegated worker.service sibling",
      caller: `0::${root}/workers/sibling`,
      gateway: `0::${root}/workers/worker.service`,
      expected: "inside",
    },
    {
      label: "unit prefix lookalike",
      caller: `0::${root}-other.service`,
      gateway: `0::${root}`,
      expected: "outside",
    },
    {
      label: "external terminal",
      caller: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/terminal.scope",
      gateway: `0::${root}`,
      expected: "outside",
    },
    {
      label: "legacy hierarchy",
      caller: `1:name=systemd:${root}/worker`,
      gateway: `1:name=systemd:${root}`,
      expected: "inside",
    },
    {
      label: "hybrid hierarchy",
      caller: `0::/\n1:name=systemd:${root}/worker`,
      gateway: `0::/\n1:name=systemd:${root}`,
      expected: "inside",
    },
    { label: "caller root hierarchy", caller: "0::/", gateway: `0::${root}`, expected: "outside" },
    {
      label: "external login scope",
      caller: "0::/user.slice/user-1000.slice/session-5.scope",
      gateway: `0::${root}`,
      expected: "outside",
    },
    { label: "unmanaged Gateway", caller: `0::${root}`, gateway: "0::/", expected: "unknown" },
    {
      label: "non-systemd controller",
      caller: `1:cpu:${root}`,
      gateway: `0::${root}`,
      expected: "unknown",
    },
    {
      label: "conflicting authorities",
      caller: `1:name=systemd:${root}\n2:name=systemd:/other.service`,
      gateway: `0::${root}`,
      expected: "unknown",
    },
    {
      label: "incomparable v1 and v2 paths",
      caller: "1:name=systemd:/outside.service",
      gateway: `0::${root}`,
      expected: "unknown",
    },
    {
      label: "different named hierarchy identities",
      caller: "1:name=systemd:/outside.service",
      gateway: `2:name=systemd:${root}`,
      expected: "unknown",
    },
    {
      label: "path traversal",
      caller: `0::${root}/../outside`,
      gateway: `0::${root}`,
      expected: "unknown",
    },
    {
      label: "malformed output",
      caller: "unavailable",
      gateway: `0::${root}`,
      expected: "unknown",
    },
  ])("classifies $label from native membership", ({ caller, gateway, expected }) => {
    vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "unrelated.service");
    native.read.mockImplementation((file: string) => {
      if (file === `/proc/${process.pid}/cgroup`) {
        return caller;
      }
      if (file === `/proc/${gatewayPid}/cgroup`) {
        return gateway;
      }
      throw new Error("Unexpected native path");
    });
    expect(inspectServiceProcessMembershipSync(gatewayPid, "linux", root)).toBe(expected);
  });
  it.each([
    { label: "missing", controlGroup: undefined },
    { label: "empty", controlGroup: "" },
    { label: "root", controlGroup: "/" },
    { label: "relative", controlGroup: "openclaw-gateway.service" },
    { label: "path traversal", controlGroup: `${root}/../other.service` },
    { label: "foreign", controlGroup: "/system.slice/another-gateway.service" },
    { label: "prefix lookalike", controlGroup: `${root}-other.service` },
  ])("does not infer membership from a $label ControlGroup", ({ controlGroup }) => {
    native.read.mockImplementation((file: string) =>
      file === `/proc/${gatewayPid}/cgroup` ? `0::${root}` : "0::/user.slice/session-5.scope",
    );
    expect(inspectServiceProcessMembershipSync(gatewayPid, "linux", controlGroup)).toBe("unknown");
  });
  it("keeps denied procfs inspection unknown", () => {
    expect(inspectServiceProcessMembershipSync(gatewayPid, "linux", root)).toBe("unknown");
  });
});

it("does not invent Windows Job membership from environment hints", () => {
  vi.stubEnv("OPENCLAW_WINDOWS_TASK_NAME", "OpenClaw Gateway");
  expect(inspectServiceProcessMembershipSync(gatewayPid, "win32")).toBe("unknown");
});
