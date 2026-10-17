import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("observes one-shot and IPC sync requests without changing transport or inventing custody", async () => {
  const root = dirs.make("survivor-passive-observer-");
  const source = path.join(root, "source.sqlite");
  const worker = path.join(root, "worker.mjs");
  const runner = path.join(root, "runner.mjs");
  fs.writeFileSync(
    path.join(root, "snapshot-cleanup-fixture.json"),
    JSON.stringify({ source, gatewayPid: process.pid }),
  );
  // Fixed transport peer, not a fabricated snapshot/custody receipt or a product boot.
  fs.writeFileSync(
    worker,
    String.raw`if (process.argv[3] === "session") {
  process.on("message", (message) => {
    if (message === "close") process.disconnect();
    else process.send(message);
  });
} else {
  process.stdout.write(JSON.stringify(process.argv.slice(2)));
}
`,
  );
  fs.writeFileSync(
    runner,
    String.raw`import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
const root = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const fixture = JSON.parse(fs.readFileSync(path.join(root, "snapshot-cleanup-fixture.json"), "utf8"));
const marker = "--openclaw-sqlite-readonly-child";
const worker = path.join(root, "worker.mjs");
const source = fixture.source;
const staging = path.join(root, "staging");
const reportPath = path.join(root, "passive-" + process.pid + "-0.json");
const read = () => JSON.parse(fs.readFileSync(reportPath, "utf8"));
const kill = process.kill;
let probeError;
// Only the OS liveness result is faulted; requests, sends, callbacks and close are native.
process.kill = function (pid, signal) {
  if (pid === fixture.gatewayPid && signal === 0 && probeError) {
    throw Object.assign(new Error("synthetic liveness failure"), { code: probeError });
  }
  return kill.call(this, pid, signal);
};
for (const [requestSource, error] of [[source, undefined], [source + ".other", "ESRCH"], [source, "EPERM"]]) {
  probeError = error;
  const args = [marker, "sync", requestSource, staging];
  let output;
  const child = execFile(process.execPath, [worker, ...args], (error, stdout) => {
    assert.ifError(error);
    output = JSON.parse(stdout);
  });
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.deepEqual(output, args);
}
let report = read();
assert.equal(report.overflow, false);
assert.equal(report.counts.launches, 3);
assert.deepEqual(report.launches.map((row) => row.requests), [
  [{ sourceMatches: true, gatewayPresent: true }],
  [{ sourceMatches: false, gatewayPresent: false }],
  [{ sourceMatches: true, gatewayPresent: "unknown:EPERM" }],
]);
for (const row of report.launches) {
  assert.equal(row.method, "execFile");
  assert.equal(row.mode, "sync");
  assert.deepEqual(row.close, { code: 0, signal: null });
}
probeError = undefined;
const child = spawn(process.execPath, [worker, marker, "session"], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
child.stdout.resume();
child.stderr.pipe(process.stderr);
const closed = once(child, "close");
let callbacks = 0;
try {
  for (let id = 1; id <= 33; id++) {
    const message = { id, args: ["sync", source, staging], extra: "preserve-payload" };
    const reply = once(child, "message");
    await new Promise((resolve, reject) => {
      const sent = child.send(message, (error) => {
        callbacks++;
        if (error) reject(error);
        else resolve();
      });
      assert.equal(typeof sent, "boolean");
    });
    assert.deepEqual((await reply)[0], message);
  }
} finally {
  // Match the real owner: the child disconnects after the close message.
  if (child.connected) child.send("close");
  assert.deepEqual(await closed, [0, null]);
}
report = read();
assert.equal(callbacks, 33);
assert.equal(report.counts.launches, 4);
assert.equal(report.overflow, true);
assert.deepEqual(report.launches[3], {
  method: "spawn", pid: child.pid, mode: "session",
  requests: Array.from({ length: 32 }, (_, index) => ({
    id: index + 1, sourceMatches: true, gatewayPresent: true,
  })),
  close: { code: 0, signal: null },
});
`,
  );
  let stderr = "";
  const code = await runManagedCommand({
    bin: resolveTestNodeExecPath(),
    args: [
      "--import",
      pathToFileURL(path.resolve("scripts/e2e/lib/upgrade-survivor/packaged-doctor-passive.mjs"))
        .href,
      runner,
    ],
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
    },
    stdio: ["ignore", "ignore", "pipe"],
    onReady(child) {
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    },
    timeoutMs: 5_000,
    requireProcessTreeExit: true,
  });
  expect(code, stderr).toBe(0);
});
