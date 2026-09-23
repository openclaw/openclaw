import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { ServiceInspectionError } from "./service-inspection-error.js";
import { readGatewayServiceState, resolveGatewayService, type GatewayService } from "./service.js";
import { createMockGatewayService, mockSystemAccountHome } from "./service.test-helpers.js";
import { readSystemdServiceRuntime } from "./systemd-runtime.js";

const serviceEnv = (scenario: string) => ({
  HOME: `/openclaw-service-proof/${scenario}`,
  XDG_RUNTIME_DIR: `/openclaw-service-proof/${scenario}/runtime`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/openclaw-service-proof/${scenario}/bus`,
  USER: "service",
  LOGNAME: "service",
  SUDO_USER: undefined,
});

beforeEach(() => {
  mockSystemAccountHome();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("readGatewayServiceState absence", () => {
  it.each(
    (["user", "system"] as const).flatMap((scope) =>
      ["missing-tools", "not-booted"].map((manager) => ({ scope, manager })),
    ),
  )("reports a stale $scope unit with $manager", async ({ scope, manager }) => {
    mockProcessPlatform("linux");
    const env = serviceEnv(`${scope}-${manager}`);
    const unitPath =
      scope === "user"
        ? `${env.HOME}/.config/systemd/user/openclaw-gateway.service`
        : "/etc/systemd/system/openclaw-gateway.service";
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockImplementation(async (file) => {
      if (file !== unitPath) {
        throw missing();
      }
      return "[Service]\nExecStart=/usr/bin/node /old/openclaw/dist/index.js gateway\n";
    });
    vi.spyOn(fs, "access").mockImplementation(async (file) => {
      if (file !== unitPath) {
        throw missing();
      }
    });
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    vi.spyOn(await import("./exec-file.js"), "execFileUtf8").mockImplementation(async () => ({
      code: 1,
      termination: manager === "missing-tools" ? "error" : "exit",
      errorCode: manager === "missing-tools" ? "ENOENT" : undefined,
      stdout: "",
      stderr: "System has not been booted with systemd as init system (PID 1). Can't operate.",
    }));
    const state = await readGatewayServiceState(resolveGatewayService(), { env });
    expect(state.systemdInstallation?.kind).toBe(scope);
    expect(state.installed).toBe(true);
    expect(state.inspectionReason).toBe("service-manager-unavailable");
    expect(state.runtime?.inspectionReason).toBe("service-manager-unavailable");
  });

  it("retains proven manager absence without a recorded unit", async () => {
    mockProcessPlatform("linux");
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "lstat").mockRejectedValue(missing());
    vi.spyOn(fs, "access").mockRejectedValue(missing());
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    const native = vi.spyOn(await import("./exec-file.js"), "execFileUtf8");
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: { ...serviceEnv("no-manager-or-unit"), DBUS_SESSION_BUS_ADDRESS: undefined },
    });
    expect(state).toMatchObject({
      inspectionReason: "service-manager-unavailable",
      installed: false,
      command: null,
      runtime: { inspectionReason: "service-manager-unavailable", missingUnit: true },
    });
    expect(native).not.toHaveBeenCalled();
  });

  it("preserves command inspection diagnosis when runtime availability also fails", async () => {
    vi.spyOn(await import("./systemd-exec.js"), "assertSystemdAvailable").mockRejectedValue(
      new Error("systemctl not available"),
    );
    const state = await readSystemdServiceRuntime(serviceEnv("runtime-failure"), {
      systemdReadTarget: {
        scope: "user",
        unitName: "openclaw-gateway.service",
        unitPath: "/openclaw-service-proof/runtime-failure/gateway.service",
      },
      commandInspection: {
        kind: "unavailable",
        error: new ServiceInspectionError("service-manager-unavailable"),
      },
    });
    expect(state).toMatchObject({
      status: "unknown",
      inspectionReason: "service-manager-unavailable",
    });
  });

  it("does not require a user bus to inspect a running system service", async () => {
    mockProcessPlatform("linux");
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.spyOn(fs, "readFile").mockRejectedValue(missing());
    vi.spyOn(fs, "access").mockImplementation(async (file) => {
      if (file !== "/etc/systemd/system/openclaw-gateway.service") {
        throw missing();
      }
    });
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    vi.spyOn(await import("./exec-file.js"), "execFileUtf8").mockImplementation(
      async (command) => ({
        code: command === "busctl" ? 1 : 0,
        termination: "exit",
        stdout: command === "busctl" ? "" : "LoadState=loaded\nActiveState=active\nMainPID=42\n",
        stderr: command === "busctl" ? "Failed to connect to bus: No such file or directory" : "",
      }),
    );
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: serviceEnv("running-system-service"),
    });
    expect(state.runtime).toMatchObject({ status: "running", pid: 42 });
    expect(state.inspectionReason).toBeUndefined();
  });

  it.each([
    ["user bus", "systemd-user-bus-unavailable"],
    ["busctl", "systemd-busctl-unavailable"],
  ])(
    "reports missing %s instead of recommending an impossible fresh install",
    async (missingPiece, reason) => {
      mockProcessPlatform("linux");
      const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
      vi.spyOn(fs, "readFile").mockRejectedValue(missing());
      vi.spyOn(fs, "access").mockRejectedValue(missing());
      vi.spyOn(fs, "readdir").mockResolvedValue([]);
      const run = vi.spyOn(await import("./exec-file.js"), "execFileUtf8");
      run.mockImplementation(async (command) => ({
        code: command === "busctl" ? 1 : 0,
        termination: command === "busctl" && missingPiece === "busctl" ? "error" : "exit",
        errorCode: command === "busctl" && missingPiece === "busctl" ? "ENOENT" : undefined,
        stdout:
          command === "busctl" ? "" : "LoadState=not-found\nActiveState=inactive\nSubState=dead\n",
        stderr: command === "busctl" ? "Failed to connect to bus: No such file or directory" : "",
      }));
      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: serviceEnv(reason),
      });
      expect(state.inspectionReason).toBe(reason);
      expect(state.runtime?.missingUnit).not.toBe(true);
      expect(state.runtime?.status).toBe("unknown");
    },
  );

  it.each(["current", "revoked", "expired"])(
    "preserves the admitted binding and deadline through an absent projection (%s)",
    async (condition) => {
      let current = true;
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const binding = {
        unit: "openclaw-gateway.service",
        managerUid: 1000,
        destination: ":1.0",
        verify: vi.fn(() => {
          if (!current) {
            throw new Error("original binding retired");
          }
        }),
        query: vi.fn(async () => []),
        close: vi.fn(async () => {}),
      };
      const isAbsent = vi.fn<NonNullable<GatewayService["isAbsent"]>>(async (args) => {
        if (!args.strictCommandAbsent) {
          return false;
        }
        current = condition !== "revoked";
        if (condition === "expired") {
          now += 1001;
        }
        return true;
      });
      const readCommand = vi.fn<GatewayService["readCommand"]>(async () => null);
      const readRuntime = vi.fn<GatewayService["readRuntime"]>(async () => ({
        status: "unknown",
      }));
      const observed = readGatewayServiceState(
        createMockGatewayService({ isAbsent, readCommand, readRuntime }),
        {
          env: { HOME: "/openclaw-service-proof" },
          requireEffective: true,
          requireLoadedCommand: true,
          systemdReadBinding: binding,
          timeoutMs: 1000,
        },
      );
      if (condition === "current") {
        await expect(observed).resolves.toMatchObject({
          command: null,
          runtime: { status: "stopped", missingUnit: true },
        });
      } else {
        await expect(observed).rejects.toThrow(
          condition === "revoked" ? "original binding retired" : "deadline expired",
        );
      }
      expect(readCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ systemdReadBinding: binding }),
      );
      expect(readRuntime).not.toHaveBeenCalled();
      expect(binding.close).not.toHaveBeenCalled();
    },
  );

  it.each([
    "absent",
    "system-loaded",
    "system-definition",
    "system-unavailable",
    "user-unavailable",
  ])(
    "preserves strict Linux service absence only with both scopes verified (%s)",
    async (condition) => {
      mockProcessPlatform("linux");
      const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
      vi.spyOn(fs, "readFile").mockRejectedValue(missing());
      vi.spyOn(fs, "access").mockRejectedValue(missing());
      vi.spyOn(fs, "readdir").mockResolvedValue([]);
      const present = await fs.lstat(process.cwd());
      vi.spyOn(fs, "lstat").mockImplementation(async (target) => {
        if (
          condition === "system-definition" &&
          String(target) === "/etc/systemd/system/openclaw-gateway.service"
        ) {
          return present;
        }
        throw missing();
      });
      const run = vi.spyOn(await import("./exec-file.js"), "execFileUtf8");
      run.mockImplementation(async (command, args) => {
        const system = args.includes("--system");
        const success = (type: string, data: unknown) => ({
          code: 0,
          termination: "exit" as const,
          stdout: JSON.stringify({ type, data }),
          stderr: "",
        });
        const failure = (stderr: string) => ({
          code: 1,
          termination: "exit" as const,
          stdout: "",
          stderr,
        });
        if (condition === (system ? "system-unavailable" : "user-unavailable")) {
          return failure("Failed to connect to bus: No such file or directory");
        }
        if (args.includes("Version")) {
          expect(command).toBe("busctl");
          expect(args).toEqual([
            "--user",
            "--auto-start=no",
            "get-property",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "Version",
          ]);
          return { code: 0, termination: "exit", stdout: 's "252.39"', stderr: "" };
        }
        if (args.includes("GetNameOwner")) {
          return success("s", [":1.2"]);
        }
        if (args.includes("GetUnit")) {
          return system && condition === "system-loaded"
            ? success("o", ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"])
            : failure("Call failed: Unit openclaw-gateway.service not loaded.");
        }
        if (args.includes("GetUnitFileState")) {
          return failure("Call failed: No such file or directory");
        }
        if (system && args.includes("UnitPath")) {
          return success("as", ["/etc/systemd/system"]);
        }
        return failure("Unexpected native query");
      });
      const result = readGatewayServiceState(resolveGatewayService(), {
        env: serviceEnv(condition),
        requireEffective: true,
        requireLoadedCommand: true,
      });
      if (condition === "user-unavailable") {
        await expect(result).rejects.toThrow();
      } else if (condition === "absent") {
        await expect(result).resolves.toMatchObject({
          installed: false,
          command: null,
          loadState: { status: "not-loaded" },
          runtime: { status: "stopped", missingUnit: true },
          running: false,
        });
      } else {
        expect((await result).runtime?.missingUnit).not.toBe(true);
      }
      expect(run.mock.calls.some((call) => call[1].includes("LoadUnit"))).toBe(false);
    },
  );
});
