import { spawn } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { readProcessCoalition } from "@openclaw/proc-safe/darwin";
import { expect, it } from "vitest";
import { inspectServiceProcessMembershipSync } from "./service-process-membership.js";

it.skipIf(process.platform !== "darwin")(
  "recognizes a detached process in the same launchd coalition on the main thread and a Worker",
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready'); process.stdin.resume()"],
      {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let worker: Worker | undefined;
    try {
      await once(child.stdout!, "data");
      const source = new URL("./service-process-membership.ts", import.meta.url).href;
      worker = new Worker(
        new URL(
          `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from 'node:worker_threads';
        import { readProcessCoalition } from ${JSON.stringify(import.meta.resolve("@openclaw/proc-safe/darwin"))};
        import { inspectServiceProcessMembershipSync } from ${JSON.stringify(source)};
        parentPort.postMessage({
          membership: inspectServiceProcessMembershipSync(${child.pid}),
          coalition: readProcessCoalition(process.pid),
        });
      `)}`,
        ),
        { execArgv: ["--import", new URL("../../scripts/tsx.mjs", import.meta.url).href] },
      );
      const [actual] = await once(worker, "message");
      expect(actual.membership).toBe("inside");
      const coalition = readProcessCoalition(child.pid!);
      expect(coalition?.id).toBeGreaterThan(0n);
      expect(actual.coalition?.id).toBe(coalition?.id);
      expect(readProcessCoalition(process.pid)?.id).toBe(coalition?.id);
      expect(inspectServiceProcessMembershipSync(child.pid!)).toBe("inside");
    } finally {
      await worker?.terminate();
      const exited = once(child, "exit");
      child.stdin!.end();
      await exited;
    }
  },
);
