import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { getProcessInstanceStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { createSpawnBrokerHost } from "./host.js";

// This fixture uses Linux birth identity for its own failure cleanup. It proves
// the real process boundary, not simulated coverage for other platforms.
describe.runIf(process.platform === "linux" && !process.versions.bun)(
  "detached broker cleanup",
  () => {
    it.each([
      { transport: "native", rootClosesFirst: false },
      { transport: "native", rootClosesFirst: true },
      { transport: "execa", rootClosesFirst: false },
      { transport: "execa", rootClosesFirst: true },
    ] as const)(
      "joins the inherited group for $transport (root already closed: $rootClosesFirst)",
      async ({ transport, rootClosesFirst }) => {
        const host = createSpawnBrokerHost();
        let descendantPid: number | undefined;
        let descendantStart: number | null = null;
        const descendant = `process.on("SIGTERM", () => {});
process.send("ready", () => process.disconnect());
setInterval(() => {}, 1000);`;
        const source = String.raw`const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("error", (error) => { throw error; });
child.once("message", () => {
  child.unref();
  process.stdout.write(JSON.stringify({ pid: child.pid }) + "\n");
  ${rootClosesFirst ? "" : "setInterval(() => {}, 1000);"}
});`;
        try {
          await host.ready();
          const spawned =
            transport === "native"
              ? undefined
              : host.spawnExeca([process.execPath, "-e", source], {
                  detached: true,
                  stdin: "ignore",
                  stdout: "pipe",
                  stderr: "ignore",
                  buffer: false,
                  reject: false,
                });
          void spawned?.result.catch(() => {});
          const child =
            spawned?.child ??
            host.spawn(process.execPath, ["-e", source], {
              detached: true,
              stdio: ["ignore", "pipe", "ignore"],
            });
          await child.ready();
          const [chunk] = await once(child.stdout!, "data");
          const announcement: unknown = JSON.parse(String(chunk));
          if (
            !announcement ||
            typeof announcement !== "object" ||
            !("pid" in announcement) ||
            typeof announcement.pid !== "number" ||
            !Number.isSafeInteger(announcement.pid)
          ) {
            throw new Error("Detached descendant did not report its identity");
          }
          descendantPid = announcement.pid;
          descendantStart = getProcessInstanceStartTime(descendantPid);
          expect(descendantStart).not.toBeNull();
          if (rootClosesFirst) {
            await child.waitForClose();
            await spawned?.result;
            expect(isPidDefinitelyDead(child.pid!)).toBe(true);
          }
          expect(isPidDefinitelyDead(descendantPid)).toBe(false);
          await host.close();
          // Root exit is insufficient: close must retain the escalation and join
          // the detached descendant even after public command custody has ended.
          expect(isPidDefinitelyDead(descendantPid)).toBe(true);
          expect(() => process.kill(-child.pid!, 0)).toThrow();
        } finally {
          if (
            descendantPid &&
            descendantStart !== null &&
            getProcessInstanceStartTime(descendantPid) === descendantStart &&
            !isPidDefinitelyDead(descendantPid)
          ) {
            process.kill(descendantPid, "SIGKILL");
          }
          await host.close();
        }
      },
      15_000,
    );
  },
);
