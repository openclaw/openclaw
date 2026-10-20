import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { getProcessInstanceStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { terminateLostBrokerChild } from "./cleanup.js";

vi.mock("../supervisor/cancellation-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../supervisor/cancellation-policy.js")>()),
  GRACEFUL_CANCEL_TIMEOUT_MS: 2_000,
}));

function killLeftover(pid: number | undefined, startedAt: number | null) {
  if (
    pid &&
    startedAt !== null &&
    getProcessInstanceStartTime(pid) === startedAt &&
    !isPidDefinitelyDead(pid)
  ) {
    process.kill(pid, "SIGKILL");
  }
}

it.skipIf(process.platform === "win32")(
  "settles an attached child before the grace deadline when SIGTERM ends it",
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const startedAt = child.pid ? getProcessInstanceStartTime(child.pid) : null;
    try {
      expect(String((await once(child.stdout, "data"))[0])).toBe("ready");
      if (!child.pid) {
        throw new Error("Attached child did not start");
      }
      const started = performance.now();
      await terminateLostBrokerChild(child.pid, false).settled;
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(isPidDefinitelyDead(child.pid)).toBe(true);
    } finally {
      killLeftover(child.pid, startedAt);
    }
  },
  10_000,
);

it.runIf(process.platform === "linux")(
  "joins a captured attached descendant that survives its root until escalation",
  async () => {
    const descendant = `process.on("SIGTERM", () => {});
process.stdout.write("ready");
setInterval(() => {}, 1000);`;
    const source = String.raw`const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  detached: true, stdio: ["ignore", "pipe", "ignore"]
});
child.once("error", (error) => { throw error; });
child.stdout.once("data", () => {
  process.stdout.write(JSON.stringify({ pid: child.pid }) + "\n");
});
setInterval(() => {}, 1000);`;
    const root = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rootStart = root.pid ? getProcessInstanceStartTime(root.pid) : null;
    let descendantPid: number | undefined;
    let descendantStart: number | null = null;
    try {
      const [chunk] = await once(root.stdout, "data");
      const announcement: unknown = JSON.parse(String(chunk));
      if (
        !announcement ||
        typeof announcement !== "object" ||
        !("pid" in announcement) ||
        typeof announcement.pid !== "number" ||
        !Number.isSafeInteger(announcement.pid)
      ) {
        throw new Error("Attached descendant did not report its identity");
      }
      descendantPid = announcement.pid;
      descendantStart = getProcessInstanceStartTime(descendantPid);
      expect(rootStart).not.toBeNull();
      expect(descendantStart).not.toBeNull();
      if (!root.pid) {
        throw new Error("Attached root did not start");
      }
      const rootExited = once(root, "exit");
      let didSettle = false;
      const started = performance.now();
      const settled = terminateLostBrokerChild(root.pid, false).settled.then(() => {
        didSettle = true;
      });
      await rootExited;
      expect(isPidDefinitelyDead(descendantPid)).toBe(false);
      expect(didSettle).toBe(false);
      await settled;
      expect(isPidDefinitelyDead(descendantPid)).toBe(true);
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
    } finally {
      killLeftover(root.pid, rootStart);
      killLeftover(descendantPid, descendantStart);
    }
  },
  10_000,
);
