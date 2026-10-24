import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")("drains work before launcher exit", async ({ signal }) => {
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
  pending = response.writeHead(200);
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
import { resolveOpenClawCliRespawn } from ${JSON.stringify(new URL("../../cli-invocation.mjs", import.meta.url).href)};
const handled = await runRespawnedChild(resolveOpenClawCliRespawn({ entryPath: ${JSON.stringify(worker)}, execArgv: [], args: [] }));
process.stdout.write("launcher-completed:" + handled + "\\n");
`,
  );
  const child = spawn(
    resolveTestNodeExecPath(),
    [wrapper, "--profile=fixture", "gateway", "run", "--bind", "loopback"],
    { env: { PATH: process.env.PATH, HOME: root }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  const readyLine = once(lines, "line");
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (data: Buffer) => {
      output[stream] += data.toString();
    });
  }
  let servingPid: number | undefined;
  const waitFor = <T>(gate: Promise<T>) =>
    withinTest(awaitGateBeforeSettlement(gate, closed, "launcher closed early"), signal);
  try {
    const [readyJson] = await waitFor(readyLine);
    const ready = JSON.parse(readyJson) as Record<"port" | "pid" | "parent", number>;
    servingPid = ready.pid;
    expect(ready.parent).toBe(child.pid);
    expect(servingPid).not.toBe(child.pid);
    const url = `http://127.0.0.1:${ready.port}`;
    const response = await fetch(url + "/work", { signal });
    const body = response.text().catch(() => "connection terminated before completion");
    const draining = once(lines, "line");
    child.kill("SIGTERM");
    expect(await waitFor(draining)).toEqual(["draining"]);
    const denied = await fetch(url + "/new-work", { signal });
    expect(denied.status).toBe(503);
    await denied.text();
    expect(output.stdout).not.toContain("launcher-completed");
    await (await fetch(url + "/release", { signal })).text();
    expect(await body).toBe("admitted\ncompleted\n");
    expect(await withinTest(closed, signal), output.stderr).toEqual([0, null]);
    expect(output.stdout).toContain("launcher-completed:true\n");
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
