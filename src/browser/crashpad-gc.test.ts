import { describe, expect, it } from "vitest";
import { reapStaleCrashpadHandlersForProfile } from "./crashpad-gc.js";

type ProcSpec = {
  pid: number;
  comm: string;
  args: string[];
};

function createOps(specs: ProcSpec[]) {
  const reads = new Map<string, string>();
  for (const spec of specs) {
    reads.set(`/proc/${spec.pid}/comm`, `${spec.comm}\n`);
    reads.set(`/proc/${spec.pid}/cmdline`, `${spec.args.join("\u0000")}\u0000`);
  }
  const killed = new Set<number>();
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  return {
    killed,
    signals,
    ops: {
      platform: "linux" as const,
      readdir: async (_filePath: string) => specs.map((spec) => String(spec.pid)),
      readFile: async (filePath: string) => reads.get(filePath) ?? "",
      kill: (pid: number, signal: NodeJS.Signals | 0) => {
        signals.push({ pid, signal });
        if (signal === 0) {
          if (killed.has(pid)) {
            throw new Error("not running");
          }
          return;
        }
        if (signal === "SIGKILL") {
          killed.add(pid);
        }
      },
      sleep: async () => {},
    },
  };
}

describe("reapStaleCrashpadHandlersForProfile", () => {
  it("skips on unsupported platforms", async () => {
    const result = await reapStaleCrashpadHandlersForProfile({
      userDataDir: "/tmp/openclaw/browser/openclaw/user-data",
      ops: {
        platform: "darwin",
      },
    });
    expect(result.skipped).toBe("unsupported-platform");
  });

  it("does not reap crashpad while the profile chromium process is active", async () => {
    const userDataDir = "/home/dvk/.openclaw/browser/openclaw/user-data";
    const db = `${userDataDir}/xdg-config/chromium/Crash Reports`;
    const harness = createOps([
      {
        pid: 101,
        comm: "chromium",
        args: ["chromium", `--user-data-dir=${userDataDir}`],
      },
      {
        pid: 102,
        comm: "chrome_crashpad_handler",
        args: ["chrome_crashpad_handler", `--database=${db}`],
      },
    ]);

    const result = await reapStaleCrashpadHandlersForProfile({
      userDataDir,
      ops: harness.ops,
    });

    expect(result.skipped).toBe("profile-active");
    expect(result.profileChromium).toBe(1);
    expect(result.profileCrashpad).toBe(1);
    expect(harness.signals.some((entry) => entry.signal === "SIGTERM")).toBe(false);
  });

  it("reaps stale crashpad handlers for the target profile only", async () => {
    const userDataDir = "/home/dvk/.openclaw/browser/openclaw/user-data";
    const db = `${userDataDir}/xdg-config/chromium/Crash Reports`;
    const otherDb = "/home/dvk/.openclaw/browser/other/user-data/xdg-config/chromium/Crash Reports";
    const harness = createOps([
      {
        pid: 201,
        comm: "chrome_crashpad_handler",
        args: ["chrome_crashpad_handler", `--database=${db}`],
      },
      {
        pid: 202,
        comm: "chrome_crashpad_handler",
        args: ["chrome_crashpad_handler", `--database=${otherDb}`],
      },
    ]);

    const result = await reapStaleCrashpadHandlersForProfile({
      userDataDir,
      ops: harness.ops,
      graceMs: 0,
    });

    expect(result.profileChromium).toBe(0);
    expect(result.profileCrashpad).toBe(1);
    expect(result.terminated).toBe(1);
    expect(result.killed).toBe(1);
    expect(harness.signals).toContainEqual({ pid: 201, signal: "SIGTERM" });
    expect(harness.signals).toContainEqual({ pid: 201, signal: "SIGKILL" });
    expect(harness.signals.some((entry) => entry.pid === 202 && entry.signal !== 0)).toBe(false);
  });
});
