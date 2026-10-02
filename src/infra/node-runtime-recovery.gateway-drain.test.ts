import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

describe.skipIf(process.platform === "win32")("recovered Gateway shutdown", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps admitted work alive until the serving child drains", async () => {
    const root = tempDirs.make("openclaw-recovery-drain-");
    const worker = path.join(root, "worker.mjs");
    const wrapper = path.join(root, "wrapper.mjs");
    await fs.writeFile(
      worker,
      `import { createServer } from "node:http";
let pending;
let stopping = false;
const server = createServer((request, response) => {
  if (stopping) { response.writeHead(503); response.end("draining"); return; }
  pending = response;
  response.writeHead(200);
  response.write("admitted\\n");
});
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  process.stdout.write("draining\\n");
  setTimeout(() => {
    pending.end("completed\\n");
    server.close(() => process.exit(0));
  }, 3_000);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({
  port: server.address().port, pid: process.pid, parent: process.ppid,
}) + "\\n"));
`,
    );
    await fs.writeFile(
      wrapper,
      `import { runRespawnedChild } from ${JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href)};
runRespawnedChild(process.execPath, [${JSON.stringify(worker)}], process.env);
`,
    );
    const child = spawn(
      resolveTestNodeExecPath(),
      [wrapper, "--profile=fixture", "gateway", "run", "--bind", "loopback"],
      { env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const exited = once(child, "exit");
    let servingPid: number | undefined;
    try {
      await expect.poll(() => stdout, { timeout: 10_000 }).toContain("\n");
      const ready = JSON.parse(stdout.split("\n")[0]!) as {
        port: number;
        pid: number;
        parent: number;
      };
      servingPid = ready.pid;
      expect(ready.parent).toBe(child.pid);
      expect(servingPid).not.toBe(child.pid);
      const response = await fetch(`http://127.0.0.1:${ready.port}/work`);
      const body = response.text().catch(() => "connection terminated before completion");
      child.kill("SIGTERM");
      await expect.poll(() => stdout).toContain("draining\n");
      const denied = await fetch(`http://127.0.0.1:${ready.port}/new-work`);
      expect(denied.status).toBe(503);
      await denied.text();
      expect(await body).toBe("admitted\ncompleted\n");
      expect(await exited, stderr).toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (servingPid) {
          try {
            process.kill(servingPid, "SIGKILL");
          } catch {}
        }
        child.kill("SIGKILL");
      }
      await exited;
    }
  }, 15_000);
});
