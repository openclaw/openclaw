import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { installKillGroupSeccompFilter } from "@openclaw/proc-safe/test-support";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { createSpawnBrokerHost } from "./host.js";

// A focused kernel contract, as in the subreaper fixture: the host and every broker it spawns
// inherit a filter that rejects negative-PID kill(2) with EPERM, as OpenShell does.
installKillGroupSeccompFilter();
assert.throws(() => process.kill(-2147483647, 0), { code: "EPERM" });

// A failed close reports every nested cleanup failure, so the test output names the cause.
const describeError = (error: unknown): string =>
  error instanceof AggregateError
    ? error.errors.map(describeError).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);

const closeWithin = (host: { close: () => Promise<unknown> }) =>
  Promise.race([
    host.close().then(() => "closed", describeError),
    delay(10_000, "close did not settle"),
  ]);

// An attached command and a detached one whose descendant outlives its root.
const host = createSpawnBrokerHost();
await host.ready();
const attached = host.spawn("/bin/sleep", ["30"], { detached: false, stdio: "ignore" });
const source = `const child = require("node:child_process").spawn("/bin/sleep", ["30"], { stdio: "ignore" });
child.unref();
process.stdout.write(JSON.stringify({ pid: child.pid }) + "\\n");`;
const detached = host.spawn(process.execPath, ["-e", source], {
  detached: true,
  stdio: ["ignore", "pipe", "ignore"],
});
await Promise.all([attached.ready(), detached.ready()]);
const [chunk] = await once(detached.stdout!, "data");
const descendantPid = (JSON.parse(String(chunk)) as { pid: number }).pid;
await detached.waitForClose();
const closed = await closeWithin(host);
const report = {
  closed,
  attachedDead: isPidDefinitelyDead(attached.pid!),
  descendantDead: isPidDefinitelyDead(descendantPid),
};
for (const pid of [attached.pid, descendantPid]) {
  try {
    process.kill(pid!, "SIGKILL");
  } catch {}
}
process.stdout.write(JSON.stringify(report), () => process.exit(0));
