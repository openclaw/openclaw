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
    `process.stdin.resume();
process.on("SIGTERM", () => {
  process.stdout.write("draining\\n");
  process.stdin.once("data", () => {
    process.stdout.write("completed\\n", () => process.exit(0));
  });
});
process.stdout.write(JSON.stringify({ pid: process.pid, parent: process.ppid }) + "\\n");
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
    { env: { PATH: process.env.PATH, HOME: root }, stdio: ["pipe", "pipe", "inherit"] },
  );
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  const readyLine = once(lines, "line");
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  let servingPid: number | undefined;
  const waitFor = <T>(gate: Promise<T>) =>
    withinTest(awaitGateBeforeSettlement(gate, closed, "launcher closed early"), signal);
  try {
    const [readyJson] = await waitFor(readyLine);
    const ready = JSON.parse(readyJson) as Record<"pid" | "parent", number>;
    servingPid = ready.pid;
    expect(ready.parent).toBe(child.pid);
    expect(servingPid).not.toBe(child.pid);
    const draining = once(lines, "line");
    child.kill("SIGTERM");
    expect(await waitFor(draining)).toEqual(["draining"]);
    expect(output).not.toContain("launcher-completed");
    child.stdin.write("release\n");
    expect(await withinTest(closed, signal)).toEqual([0, null]);
    expect(output).toContain("completed\nlauncher-completed:true\n");
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
