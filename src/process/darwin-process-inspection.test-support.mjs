import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const unregister = process.versions.bun ? undefined : (await import("tsx/esm/api")).register();
const {
  readDarwinProcessSnapshot,
  readDarwinProcessCensus,
  readDarwinProcessTree,
  readDarwinProcessCommandLine,
} = await import("./darwin-process-inspection.ts");
await unregister?.();

async function inspect(pid) {
  const [row] = await readDarwinProcessSnapshot(performance.now() + 1000, [pid]);
  assert.equal(row.pid, pid);
  assert.equal(row.ppid, process.pid);
  assert.equal(row.pgid, pid);
  assert.equal(row.owner, "same");
  assert.match(row.startedAt, /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  const census = [...readDarwinProcessCensus(1000)];
  assert.ok(census.some((member) => member.pid === pid && member.pgid === pid));
  for (const root of [process.pid, process.ppid]) {
    const tree = await readDarwinProcessTree(performance.now() + 1000, [root]);
    assert.ok(tree.some((member) => member.pid === pid && member.startedAt === row.startedAt));
  }
  assert.match(
    await readDarwinProcessCommandLine(pid, performance.now() + 1000),
    /darwin-census-fixture/,
  );
  return row;
}

if (!isMainThread) {
  parentPort.postMessage(await inspect(workerData.pid), []);
} else {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('message',()=>process.exit(0));process.send('ready')",
      "--",
      "darwin-census-fixture",
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const closed = once(child, "close");
  let worker;
  try {
    await Promise.race([
      once(child, "message"),
      closed.then(() => {
        throw new Error("fixture exited before readiness");
      }),
    ]);
    const main = await inspect(child.pid);
    worker = new Worker(new URL(import.meta.url), { workerData: { pid: child.pid }, execArgv: [] });
    const observed = await once(worker, "message");
    const { state: _mainState, ...mainIdentity } = main;
    const { state: _workerState, ...workerIdentity } = observed[0];
    assert.deepEqual(workerIdentity, mainIdentity);
    const ps = spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    if (process.argv.includes("--seatbelt")) {
      assert.equal(ps.error?.code, "EPERM");
    } else {
      assert.equal(ps.status, 0);
      assert.equal(ps.stdout.trim().replace(/\s+/g, " "), main.startedAt);
    }
    console.log(
      JSON.stringify({
        threads: 2,
        child: "observed",
        startedAtCompatible: true,
        psBlocked: ps.error?.code === "EPERM",
      }),
    );
  } finally {
    await worker?.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
}
