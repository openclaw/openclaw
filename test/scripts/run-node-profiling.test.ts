import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";
import { runNodeMain } from "./run-node-boundary.test-support.js";
import { createExitedProcess, it } from "./run-node.test-support.js";

it("retains separate launcher, respawned main, and worker profiles", async ({ tmp }) => {
  const filesToWrite = {
    "package.json": '{"type":"module"}',
    "dist/entry.js": "export {};",
    "openclaw.mjs": `import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
if (!process.env.PROFILE_CHILD) {
  const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]], {
    env: { ...process.env, PROFILE_CHILD: "1" }, encoding: "utf8",
  });
  if (child.status !== 0) throw new Error(child.stderr);
  console.log(JSON.stringify({ launcher: process.pid, ...JSON.parse(child.stdout) }));
} else {
  const worker = new Worker('const { threadId, parentPort } = require("node:worker_threads"); parentPort.postMessage(threadId);', { eval: true });
  const message = once(worker, "message");
  const exit = once(worker, "exit");
  const [threadId] = await message;
  await exit;
  console.log(JSON.stringify({ main: process.pid, worker: threadId }));
}
`,
  };
  for (const [name, content] of Object.entries(filesToWrite)) {
    const file = path.join(tmp, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const output = path.join(tmp, "output.log");
  const result = await runNodeMain({
    cwd: tmp,
    args: ["gateway", "stop"],
    env: {
      OPENCLAW_RUN_NODE_CPU_PROF_DIR: "profiles",
      OPENCLAW_RUN_NODE_OUTPUT_LOG: output,
      OPENCLAW_VITEST_RUNTIME: "node",
      OPENCLAW_RUNNER_LOG: "0",
    },
    spawn,
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  });
  expect(result).toBe(0);
  const { launcher, main, worker } = JSON.parse(await fs.readFile(output, "utf8"));
  const profileDir = path.join(tmp, "profiles");
  const files = (await listDirectoryTreeStrict(profileDir))
    .map((entry) => entry.relativePath)
    .filter((name) => name.endsWith(".cpuprofile"));
  expect(files).toHaveLength(3);
  for (const [pid, threadId] of [
    [launcher, 0],
    [main, 0],
    [main, worker],
  ]) {
    const file = files.find((name) => name.includes(`.${pid}.${threadId}.`));
    expect(file, "missing process/thread profile: " + pid + "/" + threadId).toBeDefined();
    const profile = JSON.parse(await fs.readFile(path.join(profileDir, file!), "utf8"));
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(profile.endTime).toBeGreaterThan(profile.startTime);
  }
});

it("rotates only native profiles belonging to the selected command", async ({ tmp }) => {
  const files = [
    "dist/entry.js",
    "profiles/openclaw-gateway/CPU.older.cpuprofile",
    "profiles/openclaw-gateway/CPU.newer.cpuprofile",
    "profiles/openclaw-gateway/notes.txt",
    "profiles/openclaw-agent/CPU.keep.cpuprofile",
    "profiles/openclaw-gateway-legacy.cpuprofile",
  ];
  for (const name of files) {
    const file = path.join(tmp, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "fixture");
  }
  await fs.utimes(path.join(tmp, files[1]!), 1, 1);
  await fs.utimes(path.join(tmp, files[2]!), 2, 2);
  expect(
    await runNodeMain({
      cwd: tmp,
      args: ["gateway", "stop"],
      env: {
        OPENCLAW_RUN_NODE_CPU_PROF_DIR: "profiles",
        OPENCLAW_RUN_NODE_CPU_PROF_MAX_FILES: "2",
        OPENCLAW_VITEST_RUNTIME: "node",
        OPENCLAW_RUNNER_LOG: "0",
      },
      spawn: () => createExitedProcess(0),
    }),
  ).toBe(0);
  await expect(fs.access(path.join(tmp, files[1]!))).rejects.toMatchObject({ code: "ENOENT" });
  for (const name of files.slice(2)) {
    expect(await fs.readFile(path.join(tmp, name), "utf8")).toBe("fixture");
  }
});
