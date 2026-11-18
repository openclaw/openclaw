import { afterEach, expect, it } from "vitest";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { fixtureReceiptClientSource, openFixtureReceiptChannel } from "./fixture-receipts.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { isProcessAlive } from "./process-wait.js";
import { withinTest } from "./promise.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "retains detached grandchildren across command crash and restart, then extinguishes custody",
  async ({ signal }) => {
    const receipts = await openFixtureReceiptChannel();
    const home = tempDirs.make("openclaw-command-crash-");
    const grandchild = `
      ${fixtureReceiptClientSource(receipts.endpoint)}
      process.send(process.pid);
      process.disconnect();
      sendReceipt("grandchild", "ready");
      await awaitRelease("grandchild", "resume");
      sendReceipt("grandchild", "resumed");
      await awaitRelease("grandchild", "finish");
    `;
    const intermediate = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}], {
        detached: true, stdio: ["ignore", "ignore", "ignore", 3, "ipc"],
      });
      child.once("message", (pid) => process.send({ grandchild: pid, intermediate: process.pid }));
      // Like a detached command owner, keep its child until custody requests cleanup.
      process.on("SIGTERM", () => child.kill("SIGKILL"));
      child.once("exit", () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const command = `
      import { spawn } from "node:child_process";
      import { createServer } from "node:http";
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(intermediate)}], {
        stdio: ["ignore", "ignore", "ignore", 3, "ipc"],
      });
      child.once("message", (descendants) => {
        const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
        createServer((request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true, status: "started", ready: true, pid: process.pid, ...descendants }));
        }).listen(port, "127.0.0.1");
      });
    `;
    const instance = await createOpenClawTestInstance({
      name: "command-crash",
      entrypoint: ["--input-type=module", "-e", command, "--"],
      signal,
      env: { HOME: home, OPENCLAW_STATE_DIR: home },
    });
    const pids: number[] = [];
    try {
      await instance.startGateway();
      const identity = await (await fetch(`http://127.0.0.1:${instance.port}/readyz`)).json();
      const original = instance.child!;
      // The exposed PID is the executing Node command, not its relay or anchor.
      expect(original.pid).toBe(identity.pid);
      pids.push(identity.pid, identity.intermediate, identity.grandchild);
      await withinTest(receipts.waitFor("grandchild", "ready"), signal);

      await instance.crashGateway();
      expect(original).toMatchObject({ exitCode: null, signalCode: "SIGKILL" });
      expect(isProcessAlive(identity.pid)).toBe(false);
      expect(isProcessAlive(identity.intermediate)).toBe(true);
      expect(isProcessAlive(identity.grandchild)).toBe(true);
      await instance.startGateway();
      const replacement = await (await fetch(`http://127.0.0.1:${instance.port}/readyz`)).json();
      expect(instance.child?.pid).toBe(replacement.pid);
      expect(replacement.pid).not.toBe(identity.pid);
      pids.push(replacement.pid, replacement.intermediate, replacement.grandchild);
      receipts.release("grandchild", "resume");
      await withinTest(receipts.waitFor("grandchild", "resumed", 2), signal);
      expect(isProcessAlive(identity.grandchild)).toBe(true);

      await instance.stopGateway();
      for (const pid of pids) {
        expect(isProcessAlive(pid), `custody left pid ${pid} alive`).toBe(false);
      }
    } finally {
      // Failed survival assertions must not strand a detached fixture process.
      for (const pid of pids.toReversed()) {
        killPidIfAlive(pid);
      }
      try {
        await instance.cleanup();
      } finally {
        await receipts.close();
      }
    }
  },
);
