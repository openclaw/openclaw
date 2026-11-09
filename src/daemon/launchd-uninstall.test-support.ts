import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  capturePassThroughOutput,
  createDefaultLaunchdEnv,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  isLaunchAgentLoaded,
  resolveLaunchAgentPlistPath,
  uninstallLaunchAgent,
} from "./launchd.js";

// Register in the caller's suite; its existing ancestry hooks own all fixture lifecycle.
export function registerLaunchdUninstallTests(ENV: Record<string, string | undefined>): void {
  describe("launchd uninstall", () => {
    it("rejects a permission-denied launchctl inspection", async () => {
      state.printError = "launchctl print permission denied";
      state.printFailuresRemaining = 1;

      await expect(isLaunchAgentLoaded({ env: createDefaultLaunchdEnv() })).rejects.toMatchObject({
        reason: "launchd-gui-domain-unavailable",
      });
    });

    it.each([
      { operation: "lstat", code: "EACCES" },
      { operation: "rename", code: "ENOENT" },
    ] as const)(
      "reports $operation $code without leaking the plist path",
      async ({ operation, code }) => {
        const plistPath = resolveLaunchAgentPlistPath(ENV);
        if (operation === "rename") {
          state.files.set(plistPath, "RunAtLoad=true");
        }
        vi.mocked(fs[operation]).mockRejectedValueOnce(
          Object.assign(new Error(`${code}: ${operation} '${plistPath}'`), { code }),
        );
        const uninstall = uninstallLaunchAgent(launchAgentControlFixture(ENV));
        await expect(uninstall).rejects.toThrow(`LaunchAgent removal failed (${code})`);
        await expect(uninstall).rejects.not.toThrow(plistPath);
        if (operation === "rename") {
          expect(state.files.has(plistPath)).toBe(true);
        }
      },
    );

    it.each([
      { operation: "mkdir", code: "EPERM" },
      { operation: "mkdir", code: "EACCES" },
      { operation: "rename", code: "EPERM" },
      { operation: "rename", code: "EACCES" },
    ] as const)(
      "removes only the booted-out plist after Trash $operation $code",
      async ({ operation, code }) => {
        const plistPath = resolveLaunchAgentPlistPath(ENV);
        const other = "/Users/test/Library/LaunchAgents/com.example.other.plist";
        state.files.set(plistPath, "RunAtLoad=true");
        state.files.set(other, "unrelated");
        vi.mocked(fs[operation]).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
        let output = "";
        const stdout = capturePassThroughOutput((text) => {
          output += text;
        });

        await expect(uninstallLaunchAgent({ env: ENV, stdout })).resolves.toBeUndefined();

        expect(state.serviceLoaded).toBe(false);
        expect(state.files.has(plistPath)).toBe(false);
        expect(state.files.get(other)).toBe("unrelated");
        expect(fs.unlink).toHaveBeenCalledExactlyOnceWith(plistPath);
        expect(output).toContain("Removed LaunchAgent");
        expect(output).not.toContain("Moved LaunchAgent to Trash");
      },
    );

    it.each([
      { operation: "mkdir", code: "EIO", unlinkCode: undefined },
      { operation: "rename", code: "EXDEV", unlinkCode: undefined },
      { operation: "rename", code: "EPERM", unlinkCode: "EACCES" },
    ] as const)(
      "reports Trash $operation $code and unlink $unlinkCode failures",
      async ({ operation, code, unlinkCode }) => {
        const plistPath = resolveLaunchAgentPlistPath(ENV);
        state.files.set(plistPath, "RunAtLoad=true");
        vi.mocked(fs[operation]).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
        const unlink = vi.spyOn(fs, "unlink");
        try {
          if (unlinkCode) {
            unlink.mockRejectedValueOnce(
              Object.assign(new Error(unlinkCode), { code: unlinkCode }),
            );
          }
          await expect(uninstallLaunchAgent(launchAgentControlFixture(ENV))).rejects.toThrow(
            `LaunchAgent removal failed (${unlinkCode ?? code})`,
          );
          expect(state.files.get(plistPath)).toBe("RunAtLoad=true");
          expect(unlink).toHaveBeenCalledTimes(unlinkCode ? 1 : 0);
        } finally {
          // RED never calls unlink; discard its unconsumed rejection before the next case.
          unlink.mockRestore();
        }
      },
    );

    it("preserves earlier Trash items across same-clock removals", async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1234);
      const plistPath = resolveLaunchAgentPlistPath(ENV);
      const earlier = "/Users/test/.Trash/ai.openclaw.gateway.plist";
      const timestamped = "/Users/test/.Trash/ai.openclaw.gateway-1234.plist";
      state.files.set(earlier, "earlier");
      state.files.set(timestamped, "timestamped");
      try {
        for (const contents of ["first", "second"]) {
          state.files.set(plistPath, contents);
          await uninstallLaunchAgent(launchAgentControlFixture(ENV));
        }
      } finally {
        clock.mockRestore();
      }
      expect(state.files.get(earlier)).toBe("earlier");
      expect(state.files.get(timestamped)).toBe("timestamped");
      expect([...state.files.entries()].filter(([file]) => file.includes("/.Trash/"))).toHaveLength(
        4,
      );
      expect([...state.files.values()]).toEqual(expect.arrayContaining(["first", "second"]));
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it("preserves the plist when launchctl cannot boot out the service", async () => {
      const plistPath = resolveLaunchAgentPlistPath(ENV);
      state.files.set(plistPath, "RunAtLoad=true");
      state.bootoutError = "launchctl bootout permission denied";

      await expect(uninstallLaunchAgent(launchAgentControlFixture(ENV))).rejects.toThrow(
        "launchctl bootout failed: launchctl bootout permission denied",
      );
      expect(state.files.has(plistPath)).toBe(true);
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it.each(["missing", "stopped symlink", "concurrently removed"])(
      "keeps removal idempotent for a %s LaunchAgent",
      async (kind) => {
        const plistPath = resolveLaunchAgentPlistPath(ENV);
        if (kind !== "missing") {
          state.files.set(plistPath, "RunAtLoad=true");
        }
        if (kind === "stopped symlink") {
          state.serviceLoaded = false;
          state.bootoutError = "Boot-out failed: 5: Input/output error";
        }
        if (kind === "concurrently removed") {
          vi.mocked(fs.rename).mockImplementationOnce(async () => {
            state.files.delete(plistPath);
            throw Object.assign(new Error(`ENOENT: no such file, rename '${plistPath}'`), {
              code: "ENOENT",
            });
          });
        }
        await expect(uninstallLaunchAgent(launchAgentControlFixture(ENV))).resolves.toBeUndefined();
        expect(state.files.has(plistPath)).toBe(false);
        if (kind === "stopped symlink") {
          expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(false);
        }
      },
    );
  });
}
