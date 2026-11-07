import { afterEach, expect, it, vi } from "vitest";
import * as pidAlive from "../shared/pid-alive.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { cleanStaleGatewayProcessesSync } from "./restart-stale-pids.js";
import type { getWindowsInstallRoots } from "./windows-install-roots.js";

const boundary = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  listeners: vi.fn(),
  args: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: boundary.spawnSync,
}));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry: () => null,
}));
vi.mock("./windows-port-pids.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-port-pids.js")>()),
  readWindowsListeningPidsOnPortSync: vi.fn(),
  readWindowsListeningPidsResultSync: boundary.listeners,
  readWindowsProcessArgsSync: vi.fn(),
  readWindowsProcessArgsResultSync: boundary.args,
}));
vi.mock("./gateway-owner-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-owner-lease.js")>()),
  readGatewayOwnerLease: () => undefined,
  readGatewayOwnerLeaseAsync: async () => undefined,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn: boundary.warn }),
}));
vi.mock("./windows-install-roots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-install-roots.js")>()),
  getWindowsInstallRoots: (): ReturnType<typeof getWindowsInstallRoots> => ({
    systemRoot: "C:\\Windows",
    programFiles: "C:\\Program Files",
    programFilesX86: "C:\\Program Files (x86)",
    programW6432: null,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each(["argv", "verified", "unknown before", "unknown after"])(
  "preserves a Windows listener with an inconsistent identity (%s)",
  (replacement) => {
    const stalePid = process.pid + 913;
    withMockedPlatform("win32", () => {
      let startedAt: number | null = replacement === "unknown before" ? null : 1000;
      let identityReads = 0;
      vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation(() => {
        const observed = startedAt;
        // Model reuse immediately after the post-argv birth observation too:
        // cleanup must carry that observation, not capture a fresh identity.
        if (replacement === "verified" && ++identityReads === 2) {
          startedAt = 2000;
        }
        return observed;
      });
      boundary.listeners.mockReturnValue({ ok: true, pids: [] });
      boundary.listeners.mockReturnValueOnce({ ok: true, pids: [stalePid] });
      boundary.args.mockImplementation(() => {
        // Replace the process after its Gateway argv has been observed.
        if (replacement !== "verified") {
          startedAt = replacement === "unknown after" ? null : 2000;
        }
        return { ok: true, args: ["openclaw", "gateway"] };
      });
      boundary.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
      vi.spyOn(process, "kill").mockReturnValue(true);
      vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

      expect(cleanStaleGatewayProcessesSync(18789)).toEqual([]);
      expect(boundary.warn).not.toHaveBeenCalledWith(expect.stringContaining("cleanup failed:"));
      expect(
        boundary.spawnSync.mock.calls.filter(([command]) =>
          String(command).endsWith("taskkill.exe"),
        ),
      ).toEqual([]);
    });
  },
);
