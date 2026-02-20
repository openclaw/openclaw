import { describe, expect, it, vi } from "vitest";
import { cleanupGatewayCgroupOrphans } from "./startup-cgroup-gc.js";

describe("cleanupGatewayCgroupOrphans", () => {
  it("skips on non-linux platforms", async () => {
    const result = await cleanupGatewayCgroupOrphans({
      ops: {
        platform: "darwin",
      },
    });

    expect(result.skipped).toBe("unsupported-platform");
    expect(result.orphaned).toBe(0);
  });

  it("terminates and force-kills orphaned cgroup members that are not descendants", async () => {
    const reads = new Map<string, string>([
      [
        "/proc/self/cgroup",
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service\n",
      ],
      [
        "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service/cgroup.procs",
        "100\n200\n300\n",
      ],
      ["/proc/100/status", "Name:\ttsx\nPPid:\t200\n"],
      ["/proc/300/status", "Name:\tchromium\nPPid:\t1\n"],
    ]);
    const alive = new Set<number>([300]);
    const sent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await cleanupGatewayCgroupOrphans({
      logger,
      graceMs: 0,
      ops: {
        platform: "linux",
        pid: 200,
        readFile: async (filePath) => reads.get(filePath) ?? "",
        kill: (pid, signal) => {
          sent.push({ pid, signal });
          if (signal === 0) {
            if (!alive.has(pid)) {
              throw new Error("not running");
            }
            return;
          }
          if (signal === "SIGTERM") {
            return;
          }
          if (signal === "SIGKILL") {
            alive.delete(pid);
            return;
          }
        },
        sleep: async () => {},
      },
    });

    expect(result.orphaned).toBe(1);
    expect(result.terminated).toBe(1);
    expect(result.killed).toBe(1);
    expect(sent).toContainEqual({ pid: 300, signal: "SIGTERM" });
    expect(sent).toContainEqual({ pid: 300, signal: "SIGKILL" });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
