import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { inspectChildWaitState } from "@openclaw/proc-safe/reaper";
import { installKillGroupSeccompFilter } from "@openclaw/proc-safe/test-support";
import { acquireLinuxChildSubreaper } from "./linux-child-subreaper.js";
import { assertProcessGroupControl } from "./service-child-group-ownership.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

function waitForAdoptedChildExit(pid: number) {
  return new Promise<void>((resolve) => {
    const observe = () => {
      // SIGCHLD can still be queued for another child, including the exited root.
      if (inspectChildWaitState(pid).kind === "running") {
        return;
      }
      process.off("SIGCHLD", observe);
      resolve();
    };
    process.on("SIGCHLD", observe);
  });
}

function spawnOwned(
  owner: ReturnType<typeof acquireLinuxChildSubreaper>,
  source: string,
  stdio: SpawnOptions["stdio"],
) {
  const child = spawn(process.execPath, ["-e", source], { stdio });
  assert.ok(child.pid);
  owner.retainSpawnedChild(child.pid, child);
  return child;
}

// A focused kernel contract, not an emulation of a sandbox service or provider.
// The full stock mandatory filter is exercised separately in isolated acceptance.
installKillGroupSeccompFilter();
assert.throws(() => process.kill(0, 0), { code: "EPERM" });
assert.throws(assertProcessGroupControl, /Process-group ownership is unavailable/u);
const receipts = [];
for (const label of ["A", "B"]) {
  const { adapter, ready } = await createServiceChildRelayAdapter({
    command: process.execPath,
    args: ["-e", "process.stdout.write(" + JSON.stringify(label + "-final-output") + ")"],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
  });
  await ready;
  let stdout = "";
  adapter.onStdout((chunk) => {
    stdout += chunk;
  });
  const result = await adapter.wait();
  await adapter.waitForExtinction();
  receipts.push({
    label,
    ...result,
    stdout,
    extinct: adapter.confirmExtinction(),
    owner: adapter.treeOwnership,
  });
  adapter.dispose();
}
// Drive repeated observation synchronously after a one-shot TERM handler has
// acknowledged its signal. No wall-clock sleep can hide a duplicate TERM.
const signalOwner = acquireLinuxChildSubreaper();
const cooperative = spawnOwned(
  signalOwner,
  'process.on("message", () => {}); process.once("SIGTERM", () => { process.once("message", () => process.send("graceful", () => process.exit(23))); process.send("term-received"); }); process.send("ready");',
  ["ignore", "ignore", "inherit", "ipc"],
);
const messages: unknown[] = [];
cooperative.on("message", (message: unknown) => messages.push(message));
const cooperativeClosed = once(cooperative, "close");
await once(cooperative, "message");
const termReceived = once(cooperative, "message");
assert.equal(signalOwner.drain("SIGTERM"), false);
assert.equal((await termReceived)[0], "term-received");
signalOwner.drain("SIGTERM");
signalOwner.drain("SIGTERM");
await new Promise<void>((resolve) => {
  cooperative.send("finish", () => resolve());
});
assert.deepEqual(await cooperativeClosed, [23, null]);
assert.deepEqual(messages, ["ready", "term-received", "graceful"]);
assert.equal(signalOwner.drain(), true);
receipts.push({
  label: "graceful-term",
  code: 23,
  signal: null,
  stdout: "",
  extinct: true,
  owner: "linux-subreaper",
});

// Exercise both exit orders with the same adopted orphan, retaining its stdout
// until native reaping and leaving the live root's wait status to libuv.
const orphanSource =
  'require("node:net").createServer().listen(String.fromCharCode(0) + "openclaw-orphan-" + process.pid, () => process.send(process.pid));';
const intermediateSource = `const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(orphanSource)}], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child.once("message", pid => process.send(pid, () => process.exit(0)));`;
for (const rootFirst of [true, false]) {
  const owner = acquireLinuxChildSubreaper();
  const code = rootFirst ? 0 : 37;
  const root = spawnOwned(
    owner,
    `const { spawn } = require("node:child_process");
     const child = spawn(process.execPath, ["-e", ${JSON.stringify(intermediateSource)}], {
       stdio: ["ignore", "inherit", "inherit", "ipc"],
     });
     let pid;
     child.once("message", value => { pid = value; });
     child.once("close", (code) => {
       if (code !== 0) process.exit(1);
       process.send(pid, () => { if (${rootFirst}) process.exit(0); });
     });
     process.once("message", () => process.exit(37));`,
    ["ignore", "pipe", "inherit", "ipc"],
  );
  const exited = once(root, "exit"),
    closed = once(root, "close");
  try {
    const [pid] = await once(root, "message");
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(
      Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s+(\d+)/m)?.[1]),
      process.pid,
    );
    if (rootFirst) {
      assert.deepEqual(await exited, [0, null]);
    }
    const orphanExited = waitForAdoptedChildExit(pid);
    // Signal listeners are unref'd; the parent holds this fixture's stdin open.
    process.stdin.resume();
    try {
      process.kill(pid, rootFirst ? 34 : "SIGTERM");
      await orphanExited;
    } finally {
      process.stdin.pause();
    }
    if (!rootFirst) {
      assert.deepEqual([root.exitCode, root.signalCode], [null, null]);
    }
    assert.equal(
      existsSync(`/proc/${pid}`),
      false,
      "adopted child must be reaped before root completion",
    );
  } finally {
    if (!rootFirst) {
      root.send("finish");
    }
    assert.deepEqual(await closed, [code, null]);
    assert.equal(owner.drain(), true);
  }
  receipts.push(
    rootFirst
      ? { label: "realtime-signal", signalNumber: 34, extinct: true }
      : { label: "active-root-orphan", code: 37, signal: null, extinct: true },
  );
}

const failed = await createServiceChildRelayAdapter({
  command: "/openclaw-missing-command-" + process.pid,
  args: [],
  stdinMode: "pipe-closed",
  oomScoreWrapperSelected: false,
});
await assert.rejects(failed.ready, /ENOENT/u);
await failed.adapter.waitForExtinction();
receipts.push({
  label: "startup-failed",
  code: null,
  signal: null,
  stdout: "",
  extinct: failed.adapter.confirmExtinction(),
  owner: failed.adapter.treeOwnership,
});
failed.adapter.dispose();
assert.throws(() => process.kill(-2147483647, 0), { code: "EPERM" });
process.stdout.write(JSON.stringify(receipts));
