import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { requireNodeTool } from "../../../test/helpers/node-toolchain.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { createSpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

it.skipIf(process.platform !== "linux")(
  "confirms a broker group whose dead members await another reaper",
  async () => {
    const cleanupUrl = new URL("./cleanup.ts", import.meta.url);
    const loader = new URL("../../../scripts/tsx.mjs", import.meta.url);
    // The driver is a child subreaper that, like a supervisor tracking only its own
    // spawned PIDs, never reaps adopted orphans. It owns every PID this fixture creates.
    const driver = `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
await import(${JSON.stringify(loader.href)});
const { terminateBrokerProcessGroup } = await import(${JSON.stringify(cleanupUrl.href)});
const { becomeChildSubreaper, inspectChildWaitState, reapChild } =
  createRequire(${JSON.stringify(cleanupUrl.href)})("@openclaw/proc-safe/reaper");
becomeChildSubreaper();
const member =
  "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),300));process.send('ready');setInterval(()=>{},1000)";
// A broker-like leader owns a private group, starts one member, then exits first.
const leader = spawn(process.execPath, ["-e", \`
  const child = require("node:child_process").spawn(process.execPath, ["-e", \${JSON.stringify(member)}], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", () => {
    process.send(child.pid);
    child.disconnect();
    child.unref();
    process.disconnect();
  });
\`], { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
const [memberPid] = await once(leader, "message");
await once(leader, "exit");
const observe = () => {
  const stat = readFileSync("/proc/" + memberPid + "/stat", "utf8");
  const [state, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state, ppid: Number(ppid), pgid: Number(pgid) };
};
try {
  const adopted = observe();
  const started = performance.now();
  let outcome = "settled";
  try {
    await terminateBrokerProcessGroup(leader.pid).settled;
  } catch (error) {
    outcome = String(error?.message ?? error);
  }
  const elapsedMs = performance.now() - started;
  process.stdout.write(JSON.stringify({
    driver: process.pid, leader: leader.pid, adopted, settledAt: observe(), outcome, elapsedMs,
  }));
} finally {
  if (inspectChildWaitState(memberPid).kind === "running") {
    process.kill(memberPid, "SIGKILL");
    while (inspectChildWaitState(memberPid).kind === "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  reapChild(memberPid);
}
`;
    const { stdout } = await promisify(execFile)(
      requireNodeTool("node"),
      ["--input-type=module", "-e", driver],
      { timeout: 20_000 },
    );
    const result = JSON.parse(stdout);
    // The fixture really left an adopted member in the broker's original group.
    expect(result.adopted).toMatchObject({ ppid: result.driver, pgid: result.leader });
    expect(result.outcome).toBe("settled");
    // Settlement waited for the member to die, but not for SIGKILL escalation.
    expect(result.settledAt).toEqual({ state: "Z", ppid: result.driver, pgid: result.leader });
    expect(result.elapsedMs).toBeLessThan(GRACEFUL_CANCEL_TIMEOUT_MS);
  },
  30_000,
);

describe.skipIf(skipBrokerTests)("spawn broker joined shutdown", () => {
  it("retains child cleanup until a stopped broker resumes its shutdown", async () => {
    const host = createSpawnBrokerHost();
    let childPid: number | undefined;
    let stopped = false;
    try {
      await host.ready();
      const child = host.spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await child.ready();
      childPid = child.pid;
      expect(String((await once(child.stdout!, "data"))[0])).toBe("ready");
      // The broker cannot process disconnect or perform its own graceful cleanup.
      process.kill(host.pid!, "SIGSTOP");
      const closing = host.close();
      expect(isPidDefinitelyDead(host.pid!)).toBe(false);
      // A paused owner cannot settle native work. Resume it instead of treating
      // a watchdog kill as proof that its cleanup ran.
      process.kill(host.pid!, "SIGCONT");
      await closing;
      stopped = isPidDefinitelyDead(childPid!);
      expect(stopped).toBe(true);
      expect(isPidDefinitelyDead(host.pid!)).toBe(true);
    } finally {
      if (host.pid && !isPidDefinitelyDead(host.pid)) {
        process.kill(host.pid, "SIGCONT");
      }
      if (!stopped && childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      await host.close();
    }
  }, 15_000);
});
