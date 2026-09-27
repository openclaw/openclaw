import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock("node:fs", () => ({ default: native }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  { label: "running", pid: 123, populated: true, expected: "/openclaw-gateway.service" },
  { label: "draining descendants", pid: 0, populated: true, expected: "/openclaw-gateway.service" },
  { label: "stopped", pid: 0, populated: false, expected: "" },
])("reports native cgroup custody through both manager adapters when $label", async (row) => {
  const controlGroup = "/openclaw-gateway.service";
  const daemonLog = "/fixture/gateway.log";
  vi.stubEnv("HOME", "/fixture");
  vi.spyOn(process, "kill").mockReturnValue(true);
  native.statSync.mockReturnValue({ uid: 1000, ino: 42 });
  native.existsSync.mockImplementation((file) => String(file).endsWith(".loaded-unit"));
  native.readFileSync.mockImplementation((file) => {
    const name = String(file);
    if (name.endsWith("systemd-fixture-runtime.json")) {
      return JSON.stringify({ daemonLog, controlGroup });
    }
    if (name === `${daemonLog}.runtime.json`) {
      return JSON.stringify({ pid: row.pid, supervisorPid: 0, groupPid: 0 });
    }
    if (name === `${daemonLog}.exit.json`) {
      return JSON.stringify({ last: { code: 0 } });
    }
    if (name === `/sys/fs/cgroup${controlGroup}/cgroup.events`) {
      return `populated ${row.populated ? 1 : 0}\nfrozen 0\n`;
    }
    if (name === "/proc/123/stat") {
      return "123 (gateway) S 1";
    }
    if (name.endsWith(".loaded-unit")) {
      return "[Service]\nExecStart=/usr/bin/node gateway\n";
    }
    throw new Error(`Unexpected fixture read: ${name}`);
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = ["node", "fixture", "runtime"];
  await import("../../scripts/e2e/lib/upgrade-survivor/systemd-fixture.mjs");
  expect(error).not.toHaveBeenCalled();
  expect(log.mock.calls.flat().join("\n").split("\n")).toContain(`ControlGroup=${row.expected}`);

  vi.resetModules();
  log.mockClear();
  process.argv = [
    "node",
    "fixture",
    "busctl",
    "--user",
    "--auto-start=no",
    "--json=short",
    "get-property",
    ":1.42",
    "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice",
    "org.freedesktop.systemd1.Service",
    "Result",
    "NRestarts",
    "MainPID",
    "ExecMainStatus",
    "ExecMainCode",
    "KillMode",
    "TasksCurrent",
    "MemoryCurrent",
    "ControlGroup",
  ];
  await import("../../scripts/e2e/lib/upgrade-survivor/systemd-fixture.mjs");
  expect(error).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ type: "s", data: row.expected });
});
