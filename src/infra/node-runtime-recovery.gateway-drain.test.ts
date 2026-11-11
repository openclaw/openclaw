import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

it.skipIf(process.platform === "win32")("drains work before launcher exit", async ({ signal }) => {
  const worker = `process.stdin.resume();
process.on("SIGTERM", () => {
  process.stdout.write("draining\\n");
  process.stdin.once("data", () => {
    process.stdout.write("completed\\n", () => process.exit(0));
  });
});
process.stdout.write(JSON.stringify({ pid: process.pid, parent: process.ppid }) + "\\n");`;
  const wrapper = `import { runRespawnedChild } from ${JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href)};
const handled = await runRespawnedChild({ command: process.execPath, args: ["-e", ${JSON.stringify(worker)}], env: process.env });
process.stdout.write("launcher-completed:" + handled + "\\n");
`;
  const child = spawn(
    resolveTestNodeExecPath(),
    ["--input-type=module", "-e", wrapper, "--", "fixture", "gateway", "run"],
    { env: {}, stdio: ["pipe", "pipe", "inherit"] },
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
