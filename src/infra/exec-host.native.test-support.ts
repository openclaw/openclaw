// Launched only by ExecHostTransportProofTests in a fresh, process-isolated state root.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { ignoreMissingPath } from "./errno.js";
import { requestExecHostViaSocket, type ExecHostRequest } from "./exec-host.js";

const [rootArgument, nativeSocket] = process.argv.slice(2);
assert.equal(process.env.OPENCLAW_EXEC_HOST_NATIVE_PROOF, "1");
assert.ok(rootArgument, "Native proof requires an isolated root argument");
assert.ok(nativeSocket, "Native proof requires a socket path argument");
const root = await fs.realpath(rootArgument);
assert.equal(path.dirname(root), await fs.realpath("/tmp"));
assert.ok(path.basename(root).startsWith("oc-exec-native-"));
assert.equal(await fs.realpath(process.env.OPENCLAW_STATE_DIR!), path.join(root, "state"));
const token = "exec-host-native-proof-token";
const marker = path.join(root, "native-markers");
const release = path.join(root, "release-child");
await Promise.all([marker, release].map((file) => fs.rm(file, { force: true })));
const shellScript =
  'printf "START\\n" >> "$1"; while [ ! -f "$2" ]; do /bin/sleep 0.01; done; printf "COMPLETE\\n" >> "$1"';
const request: ExecHostRequest = {
  command: ["/bin/sh", "-c", shellScript, "exec-host-native-proof", marker, release],
  cwd: root,
  timeoutMs: 5_000,
  needsScreenRecording: false,
};

function send(payload: ExecHostRequest, socketPath = nativeSocket) {
  return requestExecHostViaSocket({ socketPath, token, request: payload, timeoutMs: 10_000 });
}

async function waitForStart() {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await fs.readFile(marker, "utf8").catch(ignoreMissingPath)) === "START\n") {
      return;
    }
    await delay(10);
  }
  throw new Error("Native child did not write START before the response fault");
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return withTestTimeout(promise, ms, "Native proof deadline exceeded");
}

function assertSuccess(result: Awaited<ReturnType<typeof send>>) {
  assert.ok(result?.ok === true);
  assert.equal(result.payload.success, true);
  assert.equal(result.payload.exitCode, 0);
  return result.payload;
}

const success = await send({
  command: ["/bin/echo", "native-success"],
  cwd: root,
  timeoutMs: 5_000,
});
assert.equal(assertSuccess(success).stdout, "native-success\n");
const denied = await send({ ...request, agentId: "denied" });
assert.ok(denied?.ok === false);
assert.equal(denied.error.reason, "security=deny");
await assert.rejects(fs.stat(marker), { code: "ENOENT" });
console.log("native success and policy denial verified");

const proxySocket = path.join(root, "proxy.sock");
const sockets: net.Socket[] = [];
const closes: Promise<void>[] = [];
const forwarded = createDeferred<net.Socket>();
const nativeResponse = createDeferred<string>();
const errors: Error[] = [];
function track(socket: net.Socket) {
  const closed = createDeferred();
  socket.once("close", () => closed.resolve());
  sockets.push(socket);
  closes.push(closed.promise);
  socket.on("error", (error) => errors.push(error));
  return socket;
}
const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
  track(client);
  const upstream = track(net.createConnection({ path: nativeSocket, allowHalfOpen: true }));
  // pipe forwards the signed bytes unchanged and forwards the request's write EOF.
  client.pipe(upstream);
  client.once("end", () => forwarded.resolve(client));
  let response = "";
  upstream.setEncoding("utf8");
  upstream.on("data", (chunk: string) => {
    response += chunk;
  });
  upstream.once("end", () => nativeResponse.resolve(response));
});
try {
  const listening = once(proxy, "listening");
  proxy.listen(proxySocket);
  await listening;
  const outcome = send(request, proxySocket);
  const caller = await withDeadline(forwarded.promise, 3_000);
  await waitForStart();
  caller.end();
  assert.deepEqual(await outcome, {
    ok: false,
    error: {
      code: "UNKNOWN",
      reason: "response-lost",
      message: "UNKNOWN: macOS app exec host response was lost; execution outcome is unknown",
    },
  });
  assert.equal(await fs.readFile(marker, "utf8"), "START\n");
  await fs.writeFile(release, "finish\n");
  // Keep draining the native connection: its terminal reply proves the executor
  // awaited ShellExecutor and reaped the child, even though the caller lost it.
  const response = JSON.parse(await withDeadline(nativeResponse.promise, 8_000)) as Awaited<
    ReturnType<typeof send>
  >;
  assertSuccess(response);
  assert.equal(await fs.readFile(marker, "utf8"), "START\nCOMPLETE\n");
  assert.deepEqual(errors, []);
  console.log("native START -> response dropped -> client null -> native COMPLETE");
} finally {
  await fs.writeFile(release, "finish\n");
  try {
    // Drain even after an assertion fails so the real native child is reaped.
    if (sockets.length > 0) {
      await withDeadline(nativeResponse.promise, 8_000);
    }
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(closes);
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
