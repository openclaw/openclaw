import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { installKillGroupSeccompFilter } from "@openclaw/proc-safe/test-support";
import { acquireLinuxChildSubreaper } from "./linux-child-subreaper.js";
import { assertProcessGroupControl } from "./service-child-group-ownership.js";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

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
const cooperative = spawn(
  process.execPath,
  [
    "-e",
    'process.on("message", () => {}); process.once("SIGTERM", () => { process.once("message", () => process.send("graceful", () => process.exit(23))); process.send("term-received"); }); process.send("ready");',
  ],
  { stdio: ["ignore", "ignore", "inherit", "ipc"] },
);
assert.ok(cooperative.pid);
signalOwner.retainLibuvChild(cooperative.pid, cooperative);
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

// The root exits first, leaving its child to the dedicated owner. SIGCHLD is
// the kernel's exit notification, so the drain observes a waitable real-time exit.
const realtimeOwner = acquireLinuxChildSubreaper();
const realtimeRoot = spawn(
  process.execPath,
  [
    "-e",
    `const { spawn } = require("node:child_process");
     const child = spawn(process.execPath, ["-e", 'require("node:net").createServer().listen(String.fromCharCode(0) + "openclaw-realtime-" + process.pid)'], {
       stdio: ["ignore", "inherit", "inherit"],
     });
     process.stdout.write(String(child.pid) + "\\n");
     child.unref();`,
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
);
assert.ok(realtimeRoot.pid);
realtimeOwner.retainLibuvChild(realtimeRoot.pid, realtimeRoot);
const realtimeRootExit = once(realtimeRoot, "exit");
const realtimeRootClosed = once(realtimeRoot, "close");
const realtimePid = await new Promise<number>((resolve) => {
  let output = "";
  realtimeRoot.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("\n")) {
      resolve(Number(output.trim()));
    }
  });
});
assert.ok(Number.isSafeInteger(realtimePid) && realtimePid > 0);
assert.deepEqual(await realtimeRootExit, [0, null]);
const realtimeExited = once(process, "SIGCHLD");
// Signal listeners are unref'd; the fixture's parent keeps this stdin pipe open.
process.stdin.resume();
try {
  process.kill(realtimePid, 34);
  await realtimeExited;
} finally {
  process.stdin.pause();
}
assert.equal(realtimeOwner.drain(), true);
assert.equal(existsSync("/proc/" + realtimePid), false);
assert.deepEqual(await realtimeRootClosed, [0, null]);
receipts.push({ label: "realtime-signal", signalNumber: 34, extinct: true });

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
