import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, onTestFinished, vi } from "vitest";
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

function spawnTracked(source: string) {
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "ignore"] });
  const startedAt = child.pid ? getProcessInstanceStartTime(child.pid) : null;
  onTestFinished(() => killLeftover(child.pid, startedAt));
  assert(child.pid, "Attached child did not start");
  return { child, pid: child.pid, startedAt };
}

it.skipIf(process.platform === "win32")(
  "settles an attached child before the grace deadline when SIGTERM ends it",
  async () => {
    const { child, pid } = spawnTracked("process.stdout.write('ready');setInterval(()=>{},1000)");
    expect(String((await once(child.stdout, "data"))[0])).toBe("ready");
    const started = performance.now();
    await terminateLostBrokerChild(pid, false).settled;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(isPidDefinitelyDead(pid)).toBe(true);
  },
  10_000,
);

it.runIf(process.platform === "linux")(
  "joins a captured attached descendant that survives its root until escalation",
  async () => {
    const descendant = `process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);`;
    const source = String.raw`const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  detached: true, stdio: ["ignore", "pipe", "ignore"]
});
child.once("error", (error) => { throw error; });
child.stdout.once("data", () => {
  process.stdout.write(String(child.pid) + "\n");
});
setInterval(() => {}, 1000);`;
    const { child: root, pid, startedAt } = spawnTracked(source);
    const [chunk] = await once(root.stdout, "data");
    const descendantPid: unknown = JSON.parse(String(chunk));
    assert(typeof descendantPid === "number" && Number.isSafeInteger(descendantPid));
    const descendantStart = getProcessInstanceStartTime(descendantPid);
    onTestFinished(() => killLeftover(descendantPid, descendantStart));
    expect([startedAt, descendantStart]).not.toContain(null);
    const rootExited = once(root, "exit");
    let didSettle = false;
    const started = performance.now();
    const settled = terminateLostBrokerChild(pid, false).settled.then(() => {
      didSettle = true;
    });
    await rootExited;
    expect(isPidDefinitelyDead(descendantPid)).toBe(false);
    expect(didSettle).toBe(false);
    await settled;
    expect(isPidDefinitelyDead(descendantPid)).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
  },
  10_000,
);
