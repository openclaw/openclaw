import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const relay = spawn(process.execPath, [process.argv[2]], {
  stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
});
const control = relay.stdio[3];
assert.ok(control);
const generation = "artifact-lifecycle";
let anchorPid;
let commandPid;
let rootResult;
let closing = false;
let output = "";
let errors = "";
let pending = "";
let sequence = 0;
const cleanup = () => {
  if (anchorPid) {
    try {
      process.kill(-anchorPid, "SIGKILL");
    } catch {}
  }
  relay.kill("SIGKILL");
};
process.once("exit", cleanup);
process.once("SIGTERM", () => process.exit(1));
process.once("SIGINT", () => process.exit(1));
relay.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
relay.stderr.setEncoding("utf8").on("data", (chunk) => (errors += chunk));
relay.on("message", (message) => {
  if (message.type === "relay-error") {
    errors += message.error;
    cleanup();
  }
});
control.setEncoding("utf8").on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const message = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    assert.equal(message.generation, generation);
    if (message.type === "ready") {
      anchorPid = message.anchorPid;
      commandPid = message.commandPid;
    } else if (message.type === "root-result") {
      rootResult = { code: message.code, signal: message.signal };
    } else if (message.type === "closing") {
      closing = true;
      control.write(
        JSON.stringify({
          type: "closing-ack",
          generation,
          sequence: ++sequence,
          closingSequence: message.sequence,
        }) + "\n",
      );
    } else if (message.type === "startup-error" || message.type === "result-error") {
      errors += message.error;
      cleanup();
    }
  }
});
const closed = once(relay, "close");
relay.send({
  type: "start",
  generation,
  command: process.execPath,
  args: ["-e", "process.stdout.write('emitted relay command completed')"],
  stdinMode: "pipe-closed",
  controlFd: 3,
  acknowledgeClosing: true,
});
const [code, signal] = await closed;
assert.equal(errors, "");
assert.equal(code, 0);
assert.equal(signal, null);
assert.deepEqual(rootResult, { code: 0, signal: null });
assert.equal(output, "emitted relay command completed");
assert.equal(closing, true);
assert.ok(anchorPid);
assert.ok(commandPid);
for (const pid of [anchorPid, commandPid]) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}
process.off("exit", cleanup);
console.log("emitted relay and anchor completed and retired");
