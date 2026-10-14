import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

describe.skipIf(process.platform === "win32")("recovered Gateway shutdown", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps admitted work alive until the serving child drains", async ({ signal }) => {
    const root = tempDirs.make("openclaw-recovery-drain-");
    const worker = path.join(root, "worker.mjs");
    const wrapper = path.join(root, "wrapper.mjs");
    await fs.writeFile(
      worker,
      `import { createServer } from "node:http";
let pending;
let stopping = false;
const server = createServer((request, response) => {
  response.setHeader("Connection", "close");
  if (stopping && request.url === "/release") {
    response.end("released");
    pending.end("completed\\n");
    server.close();
    return;
  }
  if (stopping) { response.writeHead(503); response.end("draining"); return; }
  pending = response;
  response.writeHead(200);
  response.write("admitted\\n");
});
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  process.stdout.write("draining\\n");
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({
  port: server.address().port, pid: process.pid, parent: process.ppid,
}) + "\\n"));
`,
    );
    await fs.writeFile(
      wrapper,
      `import { runRespawnedChild } from ${JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href)};
const handled = await runRespawnedChild(process.execPath, [${JSON.stringify(worker)}], process.env);
process.stdout.write("launcher-completed:" + handled + "\\n");
`,
    );
    const child = spawn(
      resolveTestNodeExecPath(),
      [wrapper, "--profile=fixture", "gateway", "run", "--bind", "loopback"],
      { env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    const readyLine = createDeferred<string>();
    const draining = createDeferred();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      const lineEnd = stdout.indexOf("\n");
      if (lineEnd >= 0) {
        readyLine.resolve(stdout.slice(0, lineEnd));
      }
      if (stdout.includes("\ndraining\n")) {
        draining.resolve();
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    let servingPid: number | undefined;
    try {
      const ready = JSON.parse(
        await withinTest(
          awaitGateBeforeSettlement(
            readyLine.promise,
            closed,
            "launcher closed before the serving child was ready",
          ),
          signal,
        ),
      ) as { port: number; pid: number; parent: number };
      servingPid = ready.pid;
      expect(ready.parent).toBe(child.pid);
      expect(servingPid).not.toBe(child.pid);
      const url = `http://127.0.0.1:${ready.port}`;
      const response = await fetch(url + "/work", { signal });
      const body = response.text().catch(() => "connection terminated before completion");
      child.kill("SIGTERM");
      await withinTest(
        awaitGateBeforeSettlement(
          draining.promise,
          closed,
          "launcher closed before the serving child began draining",
        ),
        signal,
      );
      const denied = await fetch(url + "/new-work", { signal });
      expect(denied.status).toBe(503);
      await denied.text();
      expect(stdout).not.toContain("launcher-completed");
      const released = await fetch(url + "/release", { signal });
      await released.text();
      expect(await body).toBe("admitted\ncompleted\n");
      expect(await withinTest(closed, signal), stderr).toEqual([0, null]);
      expect(stdout).toContain("launcher-completed:true\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (servingPid) {
          try {
            process.kill(servingPid, "SIGKILL");
          } catch {}
        }
        child.kill("SIGKILL");
      }
      await closed;
    }
  });
});
