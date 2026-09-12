import assert from "node:assert/strict";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocketServer } from "ws";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_PUBLIC_INGRESS_PATH,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.ts";
import { parseWorkerLaunchDescriptor } from "./launch-descriptor.ts";

const [mode, workspaceDir] = process.argv.slice(2);
assert(["rejected", "cancelled", "import-error", "accepted"].includes(mode));
const previousStateDir = process.env.OPENCLAW_STATE_DIR;
const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const names = ["embedded", "inference"];
const importsStarted = new Map(names.map((name) => [name, Promise.withResolvers()]));
const importsFinished = new Map(names.map((name) => [name, Promise.withResolvers()]));
const work = [];
process.on("worker-import:started", (name) => importsStarted.get(name).resolve());
process.on("worker-import:finished", (name, stateDir) =>
  importsFinished.get(name).resolve(stateDir),
);
process.on("worker-import:work", (name) => work.push(name));

// Each child has a fresh native ESM cache. Only the two lazy modules are replaced;
// the runtime, connection, abort controller, and environment cleanup remain real.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = context.parentURL?.endsWith("/worker.runtime.ts")
      ? {
          "./embedded-agent.runtime.js": "embedded",
          "./inference-stream.runtime.js": "inference",
        }[specifier]
      : undefined;
    if (!name) {
      return nextResolve(specifier, context);
    }
    const exported =
      name === "embedded" ? "runWorkerEmbeddedTurn" : "createWorkerInferenceStreamAdapter";
    const source = `
      import { once } from "node:events";
      const released = once(process, "worker-import:release:${name}");
      process.emit("worker-import:started", "${name}");
      const [reject] = await released;
      process.emit("worker-import:finished", "${name}", process.env.OPENCLAW_STATE_DIR);
      if (reject) throw new Error("embedded import failed");
      export function ${exported}() { process.emit("worker-import:work", "${name}"); }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
const { runWorkerDescriptor } = await import("./worker.runtime.ts");
const controller = new AbortController();
const connected = Promise.withResolvers();
const disconnected = Promise.withResolvers();
const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
gateway.on("connection", (socket) => {
  socket.once("close", () => disconnected.resolve());
  socket.on("message", (data) => {
    const frame = JSON.parse(rawDataToString(data));
    assert.equal(frame.method, "connect", "No runtime RPC is expected from the controlled turn");
    connected.resolve({ socket, frame });
  });
});
await once(gateway, "listening");
const address = gateway.address();
assert(address && typeof address === "object");
const descriptor = parseWorkerLaunchDescriptor({
  version: 4,
  connectionEndpoint: {
    kind: "websocket",
    url: `ws://127.0.0.1:${address.port}${WORKER_PUBLIC_INGRESS_PATH}`,
  },
  admission: {
    environmentId: "import-environment",
    credential: "synthetic-import-admission",
    sessionId: "import-session",
    ownerEpoch: 1,
    rpcSetVersion: WORKER_RPC_SET_VERSION,
    handshake: {
      bundleHash: "a".repeat(64),
      openclawVersion: "import-test",
      protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
    },
  },
  assignment: {
    agentId: "import-agent",
    runId: "import-run",
    turnId: "import-turn",
    operationalRunInstance: { instanceId: "import-instance", runId: "import-run" },
    agentRuntimeIdentityToken: "synthetic-import-runtime",
    prompt: "Synthetic turn",
    workspaceDir,
    suppressPromptTranscript: false,
    initialMessages: [],
    modelRef: { provider: "openai", model: "gpt-5.6-luna" },
    inferenceOptions: {},
    transcript: { baseLeafId: null, nextSeq: 1 },
    liveEvents: { ackedSeq: 0, nextSeq: 1 },
    toolAuthority: { allowedToolNames: [] },
  },
});
let settled = false;
const run = (async () => {
  try {
    return { result: await runWorkerDescriptor(descriptor, { signal: controller.signal }) };
  } catch (error) {
    return { error };
  } finally {
    settled = true;
  }
})();
const release = (name, reject = false) => process.emit(`worker-import:release:${name}`, reject);
try {
  const { socket, frame } = await connected.promise;
  await Promise.all([...importsStarted.values()].map(({ promise }) => promise));
  const runtimeStateDir = process.env.OPENCLAW_STATE_DIR;
  assert.notEqual(runtimeStateDir, previousStateDir);
  assert((await stat(runtimeStateDir)).isDirectory());
  release("embedded", mode !== "accepted");
  await importsFinished.get("embedded").promise;
  // Cross an unhandled-rejection checkpoint while hello is still pending.
  // The child runs with --unhandled-rejections=strict, so an unobserved import is fatal.
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(work, []);
  if (mode === "accepted") {
    release("inference");
    await importsFinished.get("inference").promise;
    await setImmediate();
    assert.deepEqual(work, [], "Resolved imports must not execute the turn before hello");
    assert.equal(settled, false);
  }
  if (mode === "rejected") {
    socket.send(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "rejected admission",
          retryable: false,
          details: { reason: "invalid-credential" },
        },
      }),
    );
  } else if (mode === "cancelled") {
    controller.abort(new Error("operator cancelled"));
  } else {
    socket.send(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          type: "worker-hello-ok",
          environmentId: descriptor.admission.environmentId,
          sessionId: descriptor.admission.sessionId,
          ownerEpoch: 1,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
          credentialExpiresAtMs: Date.now() + 60_000,
          policy: { heartbeatIntervalMs: 60_000, maxPayload: 25 * 1024 * 1024 },
        },
      }),
    );
  }
  await disconnected.promise;
  if (mode !== "accepted") {
    await setImmediate();
    assert.equal(settled, false, "Cleanup must join the second import after the first rejects");
    assert.equal(
      process.env.OPENCLAW_STATE_DIR,
      runtimeStateDir,
      "Cleanup restored process state while an import is pending",
    );
    assert((await stat(runtimeStateDir)).isDirectory());
    release("inference");
    assert.equal(await importsFinished.get("inference").promise, runtimeStateDir);
  }
  const outcome = await run;
  if (mode === "accepted") {
    assert.deepEqual(work, ["inference", "embedded"]);
    assert.deepEqual(outcome.result, {
      status: "completed",
      transcriptLeafId: null,
      transcriptNextSeq: 1,
    });
  } else {
    assert.deepEqual(work, []);
    assert(outcome.error instanceof Error);
    assert.equal(
      outcome.error.message,
      {
        rejected: "worker admission rejected: invalid-credential",
        cancelled: "worker connection stopped",
        "import-error": "embedded import failed",
      }[mode],
    );
  }
  assert.equal(process.env.OPENCLAW_STATE_DIR, previousStateDir);
  assert.equal(process.env.OPENCLAW_CONFIG_PATH, previousConfigPath);
  await assert.rejects(stat(runtimeStateDir), { code: "ENOENT" });
  console.log(JSON.stringify({ mode, passed: true }));
} finally {
  controller.abort();
  for (const name of names) {
    release(name);
  }
  await run;
  for (const socket of gateway.clients) {
    socket.terminate();
  }
  await new Promise((resolve) => {
    gateway.close(resolve);
  });
  hooks.deregister();
}
