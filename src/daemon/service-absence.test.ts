import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { readGatewayServiceState, resolveGatewayService, type GatewayService } from "./service.js";
import { createMockGatewayService, mockSystemAccountHome } from "./service.test-helpers.js";

beforeEach(() => {
  mockSystemAccountHome();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("readGatewayServiceState absence", () => {
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
      run.mockImplementation(async (_command, args) => {
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
        env: { HOME: "/openclaw-service-proof", DBUS_SESSION_BUS_ADDRESS: "unix:path=/proof/bus" },
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
