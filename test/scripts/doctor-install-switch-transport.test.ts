import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileUtf8 } from "../../src/daemon/exec-file.js";
import { resolveSystemdUserTransport } from "../../src/daemon/systemd-user-transport.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../src/daemon/exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("../../src/daemon/systemd-peer-native.js", () => ({
  openSystemdUserManager: () => {
    throw new Error("Doctor fixture must never open a real manager socket");
  },
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
const shim = path.resolve("scripts/e2e/lib/doctor-install-switch/shims/busctl");
const versionArgs = [
  "--user",
  "--auto-start=no",
  "get-property",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "Version",
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", undefined);
  vi.stubEnv("SUDO_USER", undefined);
});
afterEach(() => vi.unstubAllEnvs());

function scenarioEnvironment() {
  const home = dirs.make("doctor-switch-transport-");
  const scenario = fs.readFileSync("scripts/e2e/lib/doctor-install-switch/scenario.sh", "utf8");
  const body = scenario.match(/use_default_service_identity\(\) \{[\s\S]*?\n\}/)?.[0];
  expect(body).toBeDefined();
  // Only replace the OS-account-home lookup. Cleanup and environment setup execute unchanged,
  // exclusively inside this test's temporary home; the full install scenario never runs.
  const result = spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    [
      "-c",
      `
set -euo pipefail
node() { [ "$1" = -p ]; printf '%s\\n' "$HOME"; }
${body}
use_default_service_identity
export USER=testuser
env -0
`,
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: path.join(home, "unavailable") },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

it.runIf(process.platform === "linux")(
  "routes the Doctor scenario through its explicit synthetic user bus",
  async () => {
    const env = scenarioEnvironment();
    const invocations: string[][] = [];
    vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
      expect(command).toBe("busctl");
      invocations.push([...args]);
      // Invoke only the repository shim; never resolve busctl from the host PATH.
      const result = spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", env });
      return {
        code: result.status ?? 1,
        termination: "exit",
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });
    await expect(resolveSystemdUserTransport(env)).resolves.toEqual({
      kind: "session-bus",
      address: env.DBUS_SESSION_BUS_ADDRESS,
      runtimeDir: env.XDG_RUNTIME_DIR,
    });
    expect(invocations).toEqual([versionArgs]);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${env.XDG_RUNTIME_DIR}/bus`);
    const runtimeDir = env.XDG_RUNTIME_DIR;
    if (!runtimeDir) {
      throw new Error("Doctor fixture must configure its synthetic runtime directory");
    }
    expect(runtimeDir.startsWith(env.HOME + path.sep)).toBe(true);
  },
);

it.runIf(process.platform === "linux")(
  "reproduces the original missing-address machine-scope rejection",
  async () => {
    const env = scenarioEnvironment();
    delete env.DBUS_SESSION_BUS_ADDRESS;
    const invocations: Array<{ command: string; args: string[] }> = [];
    vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
      invocations.push({ command, args: [...args] });
      if (command === "systemctl") {
        expect(args).toEqual(["--system", "is-system-running"]);
        return {
          code: 0,
          termination: "exit",
          stdout: "running\n",
          stderr: "",
        };
      }
      expect(command).toBe("busctl");
      const result = spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", env });
      return {
        code: result.status ?? 1,
        termination: "exit",
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });
    await expect(resolveSystemdUserTransport(env)).rejects.toMatchObject({
      reason: "systemd-user-bus-unavailable",
    });
    expect(invocations).toEqual([
      { command: "busctl", args: ["--machine", "testuser@", ...versionArgs] },
      { command: "systemctl", args: ["--system", "is-system-running"] },
    ]);
    console.info("original Doctor argv:", JSON.stringify(invocations[0]?.args));
  },
);

it.runIf(process.platform === "linux")("still rejects an unavailable synthetic bus", async () => {
  const env = scenarioEnvironment();
  vi.mocked(execFileUtf8).mockResolvedValue({
    code: 1,
    termination: "exit",
    stdout: "",
    stderr: "Failed to connect to bus: No such file or directory",
  });
  await expect(resolveSystemdUserTransport(env)).rejects.toMatchObject({
    reason: "systemd-user-bus-unavailable",
  });
});

it("keeps machine scope, auto-start, and foreign-manager probes outside the shim contract", () => {
  const env = scenarioEnvironment();
  for (const args of [
    ["--machine", "testuser@", ...versionArgs],
    versionArgs.filter((arg) => arg !== "--auto-start=no"),
    [...versionArgs.slice(0, -1), "ForeignProperty"],
  ]) {
    const result = spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", env });
    expect(result.status, JSON.stringify(args)).toBe(1);
    expect(result.stderr).toContain("unexpected invocation");
  }
});
