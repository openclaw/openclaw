// Identical test overlay runs with each revision's own loader and dependencies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const began = performance.now();
const phase = (name: string) =>
  fs.writeSync(
    2,
    `[mlx-settings-producer] ${name} pid=${process.pid} elapsedMs=${Math.floor(performance.now() - began)}\n`,
  );
phase("entry");
process.once("beforeExit", () => phase("event-loop-idle"));
const [rawPath, outputPath] = process.argv.slice(2);
assert(rawPath && outputPath && process.env.CI === "true");
assert(process.env.OPENCLAW_PROFILE?.startsWith("test-"));
const token = process.env.OPENCLAW_MLX_SETTINGS_PRODUCER_TOKEN;
const send = process.send?.bind(process);
const disconnect = process.disconnect?.bind(process);
assert(token && send && disconnect, "Settings producer requires its managed IPC owner");
const notify = (kind: string) =>
  new Promise<void>((resolve, reject) => {
    send({ kind, token }, (error) => (error ? reject(error) : resolve()));
  });
const source = fs.realpathSync(process.cwd());
const load = (relative: string) => import(pathToFileURL(path.join(source, relative)).href);
phase("paths-import-begin");
const paths = await load("src/config/paths.ts");
phase("paths-import-end");
phase("io-import-begin");
const { createConfigIO } = await load("src/config/io.ts");
phase("io-import-end");
phase("capture-import-begin");
const { captureRuntimeConfigWithSource } = await load("src/config/runtime-config-capture-state.ts");
phase("capture-import-end");
phase("handlers-import-begin");
const { talkHandlers } = await load("src/gateway/talk/handlers/index.ts");
phase("handlers-import-end");
phase("validator-import-begin");
const { validateTalkConfigResult } = await load("packages/gateway-protocol/src/index.ts");
phase("validator-import-end");
await new Promise<void>((resolve, reject) => {
  const clear = () => {
    process.removeListener("message", onMessage);
    process.removeListener("disconnect", onDisconnect);
  };
  const onDisconnect = () => {
    clear();
    reject(new Error("Settings producer owner disconnected before operation admission"));
  };
  const onMessage = (message: unknown) => {
    clear();
    if (
      !message ||
      typeof message !== "object" ||
      !("kind" in message) ||
      message.kind !== "go" ||
      !("token" in message) ||
      message.token !== token
    ) {
      reject(new Error("Invalid settings producer operation admission"));
      return;
    }
    resolve();
  };
  process.once("message", onMessage);
  process.once("disconnect", onDisconnect);
  void notify("ready").catch((error: unknown) => {
    clear();
    reject(
      error instanceof Error
        ? error
        : new Error("Settings producer readiness delivery failed", { cause: error }),
    );
  });
});
phase("operation-begin");
const state = fs.realpathSync(process.env.OPENCLAW_STATE_DIR!);
const rawURL = fs.realpathSync(rawPath);
assert.equal(rawURL, process.env.OPENCLAW_CONFIG_PATH);
assert.equal(path.dirname(rawURL), state);
assert.equal(path.dirname(path.resolve(outputPath)), state);
assert.equal(os.homedir(), process.env.HOME);
assert.equal(paths.CONFIG_PATH, rawURL);
const before = fs.readFileSync(rawURL);
phase("snapshot-begin");
const snapshot = await createConfigIO({
  configPath: rawURL,
  env: process.env,
  homedir: () => process.env.HOME!,
  observe: false,
}).readConfigFileSnapshot();
phase("snapshot-end");
assert.equal(snapshot.path, rawURL);
assert.equal(snapshot.exists, true);
assert.equal(snapshot.valid, true);
assert.equal(snapshot.raw, before.toString("utf8"));
phase("capture-begin");
const captured = captureRuntimeConfigWithSource(snapshot.config, snapshot.sourceConfig);
phase("capture-end");
let calls = 0;
let payload: unknown;
phase("handler-begin");
await talkHandlers["talk.config"]({
  req: { type: "req", id: "mlx-settings-proof", method: "talk.config" },
  params: {},
  client: { connId: "mlx-settings-proof", connect: { scopes: ["operator.read"] } },
  isWebchatConnect: () => false,
  context: {
    getRuntimeConfig: () => {
      phase("handler-runtime-config");
      return captured;
    },
  },
  respond: (ok: boolean, value: unknown, error: unknown) => {
    if (calls === 0) {
      phase("handler-respond");
    }
    calls += 1;
    assert.equal(ok, true);
    assert.equal(error, undefined);
    assert.equal(validateTalkConfigResult(value), true);
    payload = value;
  },
});
phase("handler-end");
assert.equal(calls, 1);
assert.deepEqual(fs.readFileSync(rawURL), before);
assert(payload !== undefined);
phase("write-begin");
fs.writeFileSync(outputPath, JSON.stringify(payload) + "\n", { mode: 0o600 });
phase("write-end");
console.log(
  JSON.stringify({
    rawSHA256: createHash("sha256").update(before).digest("hex"),
    actualTalkConfigResponses: calls,
  }),
);
phase("script-complete");
await notify("complete");
disconnect();
