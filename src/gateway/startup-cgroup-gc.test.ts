import { describe, expect, it, vi } from "vitest";
import { cleanupGatewayCgroupOrphans } from "./startup-cgroup-gc.js";

function makeProcStat(ppid: number, startTimeTicks: number): string {
  return `1 (proc) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startTimeTicks} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;
}

async function withStartupCgroupCleanupEnabled<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_ENABLE_STARTUP_CGROUP_GC;
  process.env.OPENCLAW_ENABLE_STARTUP_CGROUP_GC = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_ENABLE_STARTUP_CGROUP_GC;
    } else {
      process.env.OPENCLAW_ENABLE_STARTUP_CGROUP_GC = previous;
    }
  }
}

describe("cleanupGatewayCgroupOrphans", () => {
  it("is disabled by default unless explicitly opted in", async () => {
    delete process.env.OPENCLAW_ENABLE_STARTUP_CGROUP_GC;
    delete process.env.OPENCLAW_SYSTEMD_UNIT;
    const result = await cleanupGatewayCgroupOrphans({
      ops: {
        platform: "linux",
      },
    });

    expect(result.skipped).toBe("disabled");
    expect(result.orphaned).toBe(0);
  });

  it("auto-enables in systemd service context without explicit env toggle", async () => {
    delete process.env.OPENCLAW_ENABLE_STARTUP_CGROUP_GC;
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    try {
      const result = await cleanupGatewayCgroupOrphans({
        ops: {
          platform: "linux",
          readFile: async (filePath) => {
            if (filePath === "/proc/self/cgroup") {
              return "0::/user.slice/user-1000.slice/session-20.scope\n";
            }
            return "";
          },
        },
      });
      expect(result.skipped).toBe("non-service-cgroup");
    } finally {
      delete process.env.OPENCLAW_SYSTEMD_UNIT;
    }
  });

  it("skips on non-linux platforms", async () => {
    const result = await withStartupCgroupCleanupEnabled(async () => {
      return await cleanupGatewayCgroupOrphans({
        ops: {
          platform: "darwin",
        },
      });
    });

    expect(result.skipped).toBe("unsupported-platform");
    expect(result.orphaned).toBe(0);
  });

  it("skips cleanup outside systemd service cgroups", async () => {
    const result = await withStartupCgroupCleanupEnabled(async () => {
      return await cleanupGatewayCgroupOrphans({
        ops: {
          platform: "linux",
          readFile: async (filePath) => {
            if (filePath === "/proc/self/cgroup") {
              return "0::/user.slice/user-1000.slice/session-20.scope\n";
            }
            return "";
          },
        },
      });
    });

    expect(result.skipped).toBe("non-service-cgroup");
    expect(result.orphaned).toBe(0);
  });

  it("terminates and force-kills orphaned cgroup members that are not descendants", async () => {
    process.env.INVOCATION_ID = "inv-current";
    const reads = new Map<string, string>([
      [
        "/proc/self/cgroup",
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service\n",
      ],
      [
        "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/openclaw-gateway.service/cgroup.procs",
        "100\n150\n200\n300\n350\n",
      ],
      ["/proc/200/status", "Name:\topenclaw-gateway\nPPid:\t150\n"],
      ["/proc/150/status", "Name:\tnode\nPPid:\t1\n"],
      ["/proc/150/stat", makeProcStat(1, 300)],
      ["/proc/150/environ", "INVOCATION_ID=inv-current\0"],
      ["/proc/200/stat", makeProcStat(1, 500)],
      ["/proc/100/status", "Name:\ttsx\nPPid:\t200\n"],
      ["/proc/100/environ", "INVOCATION_ID=inv-current\0"],
      ["/proc/300/status", "Name:\tchromium\nPPid:\t1\n"],
      ["/proc/300/stat", makeProcStat(1, 400)],
      ["/proc/300/environ", "INVOCATION_ID=inv-old\0"],
      ["/proc/350/status", "Name:\topenclaw-gateway-wait\nPPid:\t1\n"],
      ["/proc/350/stat", makeProcStat(1, 700)],
      ["/proc/350/environ", "INVOCATION_ID=inv-current\0"],
    ]);
    const alive = new Set<number>([300]);
    const sent: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const logger = { info: vi.fn(), warn: vi.fn() };
    try {
      const result = await withStartupCgroupCleanupEnabled(async () => {
        return await cleanupGatewayCgroupOrphans({
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
      });

      expect(result.orphaned).toBe(1);
      expect(result.terminated).toBe(1);
      expect(result.killed).toBe(1);
      expect(sent).toContainEqual({ pid: 300, signal: "SIGTERM" });
      expect(sent).toContainEqual({ pid: 300, signal: "SIGKILL" });
      expect(sent).not.toContainEqual({ pid: 150, signal: "SIGTERM" });
      expect(sent).not.toContainEqual({ pid: 350, signal: "SIGTERM" });
      expect(logger.info).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.INVOCATION_ID;
    }
  });
});
