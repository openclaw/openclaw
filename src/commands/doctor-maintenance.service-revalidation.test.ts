import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { execFileUtf8 } from "../daemon/exec-file.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

vi.mock("../daemon/exec-file.js", () => ({ execFileUtf8: vi.fn() }));
// This test targets service revalidation, not database coordination; the
// private-directory coordinator check is POSIX-mode based and cannot run on
// a Windows host even with a mocked platform.
vi.mock("../infra/state-database-coordinator.js", () => ({
  acquireGatewayLifecycleCoordinator: () => ({ release: () => {} }),
  acquireStateDatabaseCoordinator: () => ({ release: () => {} }),
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));
vi.mock("../cli/daemon-cli/restart-health.js", () => ({
  waitForGatewayHealthyRestart: async () => ({ healthy: true as const }),
  renderRestartDiagnostics: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const json = (type: string, data: unknown) => ({ type, data });
const line = (entries: Array<{ type: string; data: unknown }>) =>
  entries.map((entry) => JSON.stringify(entry)).join("\n");

it("revalidates the stopped systemd user service and restarts it after repair", async () => {
  const home = tempDirs.make("openclaw-doctor-revalidate-");
  mockProcessPlatform("linux");
  mockSystemAccountHome();
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_SERVICE_REPAIR_POLICY",
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_KIND",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "SUDO_USER",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("USER", "svc");
  vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");

  const unitDir = path.join(home, ".config/systemd/user");
  await fs.mkdir(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "openclaw-gateway.service");
  const unitPosixPath = path.posix.join(home, ".config/systemd/user", "openclaw-gateway.service");
  const entrypoint = path.join(home, "openclaw.mjs");
  await fs.writeFile(entrypoint, "// fixture\n");
  await fs.writeFile(
    path.join(home, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
  );
  await fs.writeFile(
    unitPath,
    `[Service]\nExecStart=/usr/bin/node ${entrypoint} gateway\nWorkingDirectory=${home}\n`,
  );

  const managerOwner = ":1.42";
  const unitObject = "/org/freedesktop/systemd1/unit/openclaw_2dgateway";
  let stopped = false;
  const systemctlCalls: string[][] = [];
  vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
    const argv = Array.isArray(args) ? args : [args];
    if (command === "busctl") {
      const systemBus = argv.includes("--system");
      const method = argv.includes("GetNameOwner")
        ? "GetNameOwner"
        : argv.includes("GetConnectionUnixUser")
          ? "GetConnectionUnixUser"
          : argv.includes("get-property")
            ? "get-property"
            : argv.includes("GetUnit")
              ? "GetUnit"
              : argv.includes("LoadUnit")
                ? "LoadUnit"
                : "unknown";
      const iface = argv[argv.indexOf("get-property") + 3] ?? "";
      if (method === "GetNameOwner") {
        return {
          code: 0,
          termination: "exit",
          stdout: `${line([json("s", [systemBus ? ":1.7" : managerOwner])])}\n`,
          stderr: "",
        };
      }
      if (method === "GetConnectionUnixUser") {
        return {
          code: 0,
          termination: "exit",
          stdout: `${line([json("u", [1000])])}\n`,
          stderr: "",
        };
      }
      if (method === "GetUnit" || method === "LoadUnit") {
        if (systemBus) {
          return {
            code: 1,
            termination: "exit",
            stdout: "",
            stderr: "Call failed: Unit openclaw-gateway.service not loaded.",
          };
        }
        return {
          code: 0,
          termination: "exit",
          stdout: `${line([json("o", [unitObject])])}\n`,
          stderr: "",
        };
      }
      if (method === "get-property") {
        if (systemBus && argv.includes("UnitPath")) {
          return {
            code: 0,
            termination: "exit",
            stdout: `${line([json("as", ["/etc/systemd/system", "/usr/lib/systemd/system"])])}\n`,
            stderr: "",
          };
        }
        if (String(iface).includes("systemd1.Unit") && argv.includes("FragmentPath")) {
          return {
            code: 0,
            termination: "exit",
            stdout: `${line([
              json("s", unitPosixPath),
              json("as", []),
              json("b", false),
              json("s", "loaded"),
            ])}\n`,
            stderr: "",
          };
        }
        if (String(iface).includes("systemd1.Unit")) {
          const active = stopped ? "inactive" : "active";
          return {
            code: 0,
            termination: "exit",
            stdout: `${line([
              json("s", "openclaw-gateway.service"),
              json("s", "loaded"),
              json("s", active),
              json("s", stopped ? "dead" : "running"),
              json("u", 1),
              json("t", 100),
              json("t", 200),
            ])}\n`,
            stderr: "",
          };
        }
        if (String(iface).includes("systemd1.Service")) {
          if (argv.includes("ExecStart")) {
            return {
              code: 0,
              termination: "exit",
              stdout: `${line([
                json("a(sasbttttuii)", [
                  [
                    "/usr/bin/node",
                    ["/usr/bin/node", entrypoint, "gateway"],
                    false,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                  ],
                ]),
                json("s", home),
                json("as", []),
                json("a(sb)", []),
                json("as", []),
              ])}\n`,
              stderr: "",
            };
          }
          return {
            code: 0,
            termination: "exit",
            stdout: `${line([
              json("s", "success"),
              json("u", 0),
              json("u", stopped ? 0 : 1234),
              json("i", 0),
              json("i", 0),
              json("s", "control-group"),
              json("t", stopped ? 0 : 1),
              json("t", 0),
            ])}\n`,
            stderr: "",
          };
        }
      }
      throw new Error(`Unexpected busctl call: ${argv.join(" ")}`);
    }
    if (command === "systemctl") {
      systemctlCalls.push(argv);
      if (argv.includes("stop")) {
        stopped = true;
        return { code: 0, termination: "exit", stdout: "", stderr: "" };
      }
      if (argv.includes("reset-failed")) {
        return { code: 0, termination: "exit", stdout: "", stderr: "" };
      }
      if (argv.includes("restart")) {
        stopped = false;
        return { code: 0, termination: "exit", stdout: "", stderr: "" };
      }
      if (argv.includes("is-enabled") && argv.includes("--user")) {
        return { code: 0, termination: "exit", stdout: "enabled", stderr: "" };
      }
      if (argv.includes("is-enabled")) {
        return {
          code: 1,
          termination: "exit",
          stdout: "",
          stderr:
            "Failed to get unit file state for openclaw-gateway.service: No such file or directory",
        };
      }
      if (argv.includes("show")) {
        if (!argv.includes("--user")) {
          // System-scope probes: no unit owns this name on the system bus.
          return {
            code: 0,
            termination: "exit",
            stdout: argv.some((arg) => String(arg).includes("UnitPath"))
              ? "/etc/systemd/system /usr/lib/systemd/system"
              : "not-found",
            stderr: "",
          };
        }
        return {
          code: 0,
          termination: "exit",
          stdout: stopped ? "ActiveState=inactive\nMainPID=0" : "ActiveState=active\nMainPID=1234",
          stderr: "",
        };
      }
      if (argv.includes("status")) {
        return {
          code: 0,
          termination: "exit",
          stdout: "● openclaw-gateway.service - OpenClaw Gateway\n   Active: active (running)",
          stderr: "",
        };
      }
      throw new Error(`Unexpected systemctl call: ${argv.join(" ")}`);
    }
    throw new Error(`Unexpected native command: ${command}`);
  });

  const maintenance = await beginDoctorMaintenance({
    root: home,
    options: { repair: true },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
  expect(maintenance).toBeDefined();
  const { release, finish } = maintenance!;
  try {
    await expect(finish({})).resolves.toBeUndefined();
  } finally {
    await release();
  }
  // The regression left the unit stopped after repair; the fix restarts it.
  expect(systemctlCalls.some((argv) => argv.includes("restart"))).toBe(true);
});
