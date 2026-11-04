import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileUtf8 } from "../../src/daemon/exec-file.js";
import { resolveSystemdUserTransport as resolveTransport } from "../../src/daemon/systemd-user-transport.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../src/daemon/exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("../../src/daemon/systemd-peer-native.js", () => ({
  openSystemdUserManager: () => {
    throw new Error("Doctor fixture must never open a real manager socket");
  },
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
const shim = path.resolve("scripts/e2e/lib/doctor-install-switch/shims/busctl");
const runShim = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", env });
const versionArgs = (
  "--user --auto-start=no get-property org.freedesktop.systemd1 " +
  "/org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Version"
).split(" ");

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", undefined).stubEnv("SUDO_USER", undefined);
});
afterEach(() => vi.unstubAllEnvs());

function scenarioEnvironment() {
  const home = dirs.make("doctor-switch-transport-");
  const scenario = fs.readFileSync("scripts/e2e/lib/doctor-install-switch/scenario.sh", "utf8");
  const body = scenario.match(/use_default_service_identity\(\) \{[\s\S]*?\n\}/)?.[0];
  expect(body).toBeDefined();
  // Replace only account-home lookup; run the real setup inside a temporary home.
  const script = `
set -euo pipefail
node() { [ "$1" = -p ]; printf '%s\\n' "$HOME"; }
${body}
use_default_service_identity
export USER=testuser
env -0
`;
  const shell = process.platform === "darwin" ? "/bin/bash" : "bash";
  const env = { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: path.join(home, "missing") };
  const result = spawnSync(shell, ["-c", script], { encoding: "utf8", env });
  expect(result.status, result.stderr).toBe(0);
  const entries = result.stdout.split("\0").filter(Boolean);
  return Object.fromEntries(entries.map((entry) => entry.split(/[=](.*)/su, 2)));
}

it.runIf(process.platform === "linux").each([true, false])(
  "explicit bus=%s",
  async (hasAddress) => {
    const env = scenarioEnvironment();
    const { DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: runtimeDir } = env;
    expect(address).toBe(`unix:path=${runtimeDir}/bus`);
    expect(runtimeDir?.startsWith(env.HOME + path.sep)).toBe(true);
    if (!hasAddress) {
      delete env.DBUS_SESSION_BUS_ADDRESS;
    }
    vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
      if (!hasAddress && command === "systemctl") {
        return { code: 0, termination: "exit", stdout: "running\n", stderr: "" };
      }
      // Invoke only the repository shim; never resolve busctl from the host PATH.
      const { status, stdout, stderr } = runShim(args, env);
      return { code: status ?? 1, termination: "exit", stdout, stderr };
    });
    const result = resolveTransport(env);
    await (hasAddress
      ? expect(result).resolves.toEqual({ kind: "session-bus", address, runtimeDir })
      : expect(result).rejects.toMatchObject({ reason: "systemd-user-bus-unavailable" }));
    expect(vi.mocked(execFileUtf8).mock.calls.map(([command, args]) => [command, args])).toEqual(
      hasAddress
        ? [["busctl", versionArgs]]
        : [
            ["busctl", ["--machine", "testuser@", ...versionArgs]],
            ["systemctl", ["--system", "is-system-running"]],
          ],
    );
  },
);

it("rejects machine scope, autostart, and foreign-manager shim probes", () => {
  const env = scenarioEnvironment();
  for (const args of [
    ["--machine", "testuser@", ...versionArgs],
    versionArgs.filter((arg) => arg !== "--auto-start=no"),
    [...versionArgs.slice(0, -1), "ForeignProperty"],
  ]) {
    expect(runShim(args, env), JSON.stringify(args)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("unexpected invocation"),
    });
  }
});
