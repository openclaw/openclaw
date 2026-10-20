import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireTestPortBlock } from "../../../src/test-utils/port-claims.ts";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(fixture, "../../..");
const require = createRequire(repo + "/package.json");
const { WebSocket, WebSocketServer } = require("ws");
/** @param {unknown} data */
function websocketText(data) {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString("utf8");
  }
  throw new TypeError("Expected WebSocket RawData");
}
const remoteNativeUrl = process.env.OPENCLAW_CODEX_RECOVERY_REMOTE_NATIVE_URL;
const remoteNativeAuthEnv = process.env.OPENCLAW_CODEX_RECOVERY_REMOTE_NATIVE_AUTH_ENV;
// Match the production normalization of a resolved secret input.
const remoteNativeAuthToken = remoteNativeAuthEnv
  ? process.env[remoteNativeAuthEnv]?.trim()
  : undefined;
const remoteSocketOptions = remoteNativeAuthToken
  ? { headers: { Authorization: `Bearer ${remoteNativeAuthToken}` } }
  : {};
if (remoteNativeAuthEnv && !remoteNativeAuthToken) {
  throw new Error("Missing configured remote native authentication environment");
}
const recoveryRepo = process.env.OPENCLAW_CODEX_RECOVERY_RESTART_SOURCE;
let upgradeRequested = false;
let upgraded = false;
const liveSlack = process.env.OPENCLAW_CODEX_RECOVERY_LIVE_SLACK === "1";
const liveSlackTarget = liveSlack
  ? (await import("../../../extensions/slack/src/target-parsing.ts")).parseSlackTarget(
      process.env.OPENCLAW_CODEX_RECOVERY_SLACK_CHANNEL ?? "",
    )
  : undefined;
if (liveSlack && liveSlackTarget?.kind !== "channel") {
  throw new Error("Live acceptance requires an exact Slack channel target");
}
const liveSessionPrefix = liveSlackTarget
  ? `agent:main:slack:channel:${liveSlackTarget.teamId ? `team:${liveSlackTarget.teamId.toLowerCase()}:channel:` : ""}${liveSlackTarget.id.toLowerCase()}`
  : undefined;
if (
  remoteNativeUrl &&
  (!liveSlack ||
    process.env.OPENCLAW_CODEX_RECOVERY_REMOTE_PROVIDER_MODE !== "existing-native" ||
    !process.env.OPENCLAW_CODEX_RECOVERY_MODEL ||
    !process.env.OPENCLAW_CODEX_RECOVERY_NATIVE_VERSION)
) {
  throw new Error(
    "Remote acceptance requires live Slack, explicit existing-native provider mode, verified model and native version",
  );
}
const binary = process.env.OPENCLAW_CODEX_RECOVERY_BINARY;
if (!binary && !remoteNativeUrl) {
  throw new Error(
    "Set OPENCLAW_CODEX_RECOVERY_BINARY to the installed Codex app-server executable.",
  );
}
const expectBroken = process.argv.includes("--expect-broken");
const root = path.resolve(process.argv[2]);
const sourceSnapshot = (sourceRepo = repo) => {
  const manifestPath = path.join(sourceRepo, ".recovery-source.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const hash = createHash("sha256");
    for (const file of manifest.files.toSorted()) {
      hash
        .update(file)
        .update("\0")
        .update(fs.readFileSync(path.join(sourceRepo, file)));
    }
    return { commit: manifest.commit, snapshotHash: hash.digest("hex") };
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: sourceRepo, maxBuffer: 16 * 1024 * 1024 });
  const diff = git("diff", "HEAD", "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    .toString()
    .split("\0")
    .filter(Boolean)
    .toSorted();
  const hash = createHash("sha256").update(diff);
  for (const file of untracked) {
    hash
      .update(file)
      .update("\0")
      .update(fs.readFileSync(path.join(sourceRepo, file)));
  }
  return {
    commit: git("rev-parse", "HEAD").toString().trim(),
    dirty: diff.length > 0 || untracked.length > 0,
    changesHash: hash.digest("hex"),
  };
};
const source = sourceSnapshot();
let recoverySource;
const mode = process.argv[3] || "gateway-remote-active-lost-result-effect";
const gatewayRestart = mode.includes("gateway-restart");
const lostCompletion = mode.includes("lost-completion");
if (remoteNativeUrl && ((mode.includes("restart") && !gatewayRestart) || mode.includes("auth"))) {
  throw new Error(
    "Existing remote native processes and authentication cannot be changed by this fixture",
  );
}
let gatewayRestarted = false;
if (fs.existsSync(root)) {
  throw new Error("Choose a new run directory");
}
for (const d of ["home", "native-home", "workspace", "tmp"]) {
  fs.mkdirSync(path.join(root, d), { recursive: true });
}
const log = (event, data) =>
  fs.appendFileSync(
    root + "/wire.jsonl",
    JSON.stringify({ time: new Date().toISOString(), event, data }) + "\n",
  );
const nodeDir = path.dirname(process.execPath);
const model = process.env.OPENCLAW_CODEX_RECOVERY_MODEL || "gpt-5.4";
const claims = [];
const env = {
  PATH: nodeDir + ":/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: root + "/home",
  TMPDIR: root + "/tmp",
  OPENCLAW_STATE_DIR: root + "/home/.openclaw",
  OPENCLAW_CONFIG_PATH: root + "/config.json",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_CRON: "1",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost,::1,managed-devbox.repro.invalid",
  OPENAI_API_KEY: "synthetic-local-only",
};
if (liveSlack) {
  delete env.OPENCLAW_SKIP_CHANNELS;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  for (const name of [
    process.env.OPENCLAW_CODEX_RECOVERY_SLACK_BOT_ENV,
    process.env.OPENCLAW_CODEX_RECOVERY_SLACK_APP_ENV,
  ]) {
    if (!name || !process.env[name]) {
      throw new Error("Missing inherited Slack test SecretRef environment");
    }
    env[name] = process.env[name];
  }
  env.OC_REPRO_LIVE_SLACK = "1";
}
env.OC_REPRO_MODE = mode;
env.OC_REPRO_ROOT = root;
const children = [],
  sockets = new Set();
let provider, proxy;
let requestCount = 0;
const providerRequests = [];
let failProvider = !mode.includes("active");
let forcePrimaryOverload = mode.includes("model-fallback");
let faulted = false;
let pendingToolId;
let pendingToolTurnId;
let blockedRemoteMutation;
let probeToolSent = false;
let automaticReplayAttempted = false;
let automaticRecoveryWindowOpen = false;
let automaticInferenceRequests = 0;
let reconnectBlocked = false;
let cli;
let restartPromise;
const authFailure = mode.includes("auth-fallback");
const authAttempts = [];
const authorizationScheme = (headers) =>
  headers.authorization?.startsWith("Bearer ") ? "bearer" : "none";
const unauthorizedBody = JSON.stringify({
  error: {
    message: "Missing bearer or basic authentication in header",
    type: "invalid_request_error",
  },
});
const held = [];
if (mode.includes("drift")) {
  fs.writeFileSync(root + "/workspace/SOUL.md", "Synthetic persona version A.\n");
}

async function listen(s) {
  await new Promise((r, j) => {
    s.once("error", j);
    s.listen(0, process.env.OPENCLAW_CODEX_RECOVERY_LISTEN_HOST || "127.0.0.1", r);
  });
  return s.address().port;
}
function sse(res, text) {
  const item = {
    type: "message",
    id: "msg_" + requestCount,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + requestCount,
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
      },
    },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") + "data: [DONE]\n\n");
}
try {
  const respond = (raw, res) => {
    const body = JSON.parse(raw);
    if (body.generate === false) {
      // Native can prewarm before the user's turn; inject faults only into real inference.
      log("provider-warmup", { model: body.model });
      sse(res, "");
      return;
    }
    requestCount++;
    if (forcePrimaryOverload) {
      failProvider = body.model === model;
    }
    log("provider", { number: requestCount, url: "/v1/responses", body });
    providerRequests.push(body);
    // The child waits for durable startup settlement before asking for backend
    // restoration, and awaits our acknowledgement before sending a fresh request.
    // Historical restart instructions can appear as quoted context in that request.
    if (automaticRecoveryWindowOpen) {
      automaticInferenceRequests++;
    }
    const repeatsUnknownEffect =
      automaticRecoveryWindowOpen && probeToolSent && !automaticReplayAttempted;
    if (
      repeatsUnknownEffect ||
      (!probeToolSent &&
        (((mode.includes("tools55") || mode.includes("active")) && requestCount === 1) ||
          (mode.includes("joint") && !failProvider)))
    ) {
      automaticReplayAttempted ||= repeatsUnknownEffect;
      probeToolSent = true;
      const items = Array.from(
        { length: mode.includes("active") || mode.includes("joint") ? 1 : 55 },
        (_, i) => ({
          type: "function_call",
          name: mode.includes("effect") ? "gateway_exec" : "ls",
          arguments: JSON.stringify(
            mode.includes("effect")
              ? {
                  command: "printf 'effect\\n' >> effect-count.txt",
                  workdir: root + "/workspace",
                }
              : { path: root + "/workspace", limit: 1 },
          ),
          call_id: (repeatsUnknownEffect ? "call_probe_repeat_" : "call_probe_") + i,
          id: "fc_probe_" + i,
          status: "completed",
        }),
      );
      const events = items.flatMap((item, i) => [
        {
          type: "response.output_item.added",
          output_index: i,
          item: { ...item, status: "in_progress" },
        },
        { type: "response.output_item.done", output_index: i, item },
      ]);
      events.push({
        type: "response.completed",
        response: {
          id: "resp_tools",
          status: "completed",
          output: items,
          usage: { input_tokens: 20, output_tokens: 55, total_tokens: 75 },
        },
      });
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""));
      return;
    }
    if (mode.includes("sibling") && raw.includes("SIBLING_HOLD")) {
      held.push(res);
      cli.send({ kind: "sibling-ready" });
      log("sibling-held", { number: requestCount });
      return;
    }
    if (failProvider) {
      if (mode.includes("drift")) {
        fs.writeFileSync(root + "/workspace/SOUL.md", "Synthetic persona version B.\n");
        log("fault-injected", { kind: "workspace-persona-change", file: "SOUL.md" });
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(
        "data: " +
          JSON.stringify({
            type: "response.failed",
            response: {
              id: "resp_overload",
              status: "failed",
              error: {
                message: "Selected model is at capacity. Please try a different model.",
                code: "server_is_overloaded",
              },
            },
          }) +
          "\n\n",
      );
    } else {
      sse(res, "RECOVERY_OK");
    }
  };
  provider = http.createServer((req, res) => {
    if (liveSlack && req.url === "/__fixture/status") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          requestCount,
          providerMode: remoteNativeUrl ? "existing-native" : "synthetic-local",
          blockedRemoteMutation,
          faulted,
          gatewayRestarted,
          upgraded,
          effects: fs.existsSync(root + "/workspace/effect-count.txt")
            ? fs.readFileSync(root + "/workspace/effect-count.txt", "utf8")
            : "",
        }),
      );
      return;
    }
    if (
      liveSlack &&
      req.method === "POST" &&
      req.url === "/__fixture/upgrade" &&
      recoveryRepo &&
      !upgraded
    ) {
      recoverySource = sourceSnapshot(recoveryRepo);
      upgradeRequested = true;
      cli?.kill("SIGTERM");
      res.writeHead(200).end("restarting isolated test Gateway from candidate source");
      return;
    }
    if (liveSlack && req.method === "POST" && req.url === "/__fixture/offline") {
      reconnectBlocked = true;
      for (const socket of sockets) {
        socket.terminate();
      }
      res.writeHead(200).end("isolated client transport offline");
      return;
    }
    if (liveSlack && req.method === "POST" && req.url === "/__fixture/online") {
      reconnectBlocked = false;
      res.writeHead(200).end("isolated client transport restored");
      return;
    }
    if (liveSlack && req.method === "POST" && req.url === "/__fixture/inspect-session") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 4096) {
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          const { sessionKey, probeId } = JSON.parse(raw);

          if (
            typeof sessionKey !== "string" ||
            !sessionKey.startsWith("agent:main:") ||
            !liveSessionPrefix ||
            !(
              sessionKey.toLowerCase() === liveSessionPrefix ||
              sessionKey.toLowerCase().startsWith(liveSessionPrefix + ":thread:")
            ) ||
            typeof probeId !== "string" ||
            !/^[a-z0-9-]{1,80}$/.test(probeId)
          ) {
            res.writeHead(400).end("Invalid isolated live session probe");
            return;
          }
          cli?.send({ kind: "inspect-live-session", sessionKey, probeId });
          res.writeHead(202).end("Session evidence requested; require its matching receipt");
        } catch {
          res.writeHead(400).end("Invalid session evidence request");
        }
      });
      return;
    }
    if (liveSlack && req.method === "POST" && req.url === "/__fixture/stop") {
      cli?.send({ kind: "stop-live" });
      res.writeHead(200).end("stopping");
      return;
    }
    if (remoteNativeUrl && ["/__fixture/fail", "/__fixture/healthy"].includes(req.url)) {
      res
        .writeHead(409)
        .end("Existing native provider is unchanged; use transport controls for remote faults");
      return;
    }
    if (liveSlack && req.method === "POST" && req.url === "/__fixture/fail") {
      failProvider = true;
      res.writeHead(200).end("failure injection enabled");
      return;
    }
    if (liveSlack && req.method === "POST" && req.url === "/__fixture/healthy") {
      failProvider = false;
      res.writeHead(200).end("provider restored");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const scheme = authorizationScheme(req.headers);
      if (authFailure) {
        authAttempts.push({ transport: "http", scheme, model: JSON.parse(raw).model });
        if (scheme !== "bearer") {
          requestCount++;
          res.writeHead(401, { "content-type": "application/json" }).end(unauthorizedBody);
          return;
        }
      }
      respond(raw, res);
    });
  });
  const responseSockets = new WebSocketServer({ noServer: true });
  provider.on("upgrade", (req, socket, head) => {
    const scheme = authorizationScheme(req.headers);
    if (authFailure) {
      authAttempts.push({ transport: "websocket", scheme });
      if (scheme !== "bearer") {
        socket.end(
          "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: " +
            Buffer.byteLength(unauthorizedBody) +
            "\r\nConnection: close\r\n\r\n" +
            unauthorizedBody,
        );
        return;
      }
    }
    responseSockets.handleUpgrade(req, socket, head, (ws) =>
      responseSockets.emit("connection", ws, req),
    );
  });
  responseSockets.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("message", (bytes) =>
      respond(websocketText(bytes), {
        writeHead() {
          return this;
        },
        end(body) {
          for (const line of body.split("\n")) {
            if (
              line.startsWith("data: ") &&
              line !== "data: [DONE]" &&
              socket.readyState === WebSocket.OPEN
            ) {
              socket.send(line.slice(6));
            }
          }
        },
      }),
    );
  });
  const providerPort = await listen(provider);
  const providerHost = process.env.OPENCLAW_CODEX_RECOVERY_PROVIDER_HOST || "127.0.0.1";
  fs.writeFileSync(root + "/fixture-control.json", JSON.stringify({ providerPort, providerHost }));
  fs.writeFileSync(
    root + "/native-home/config.toml",
    `model = "${model}"\nmodel_provider = "openai"\nopenai_base_url = "http://${providerHost}:${providerPort}/v1"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[analytics]\nenabled = false\n`,
  );
  const nativeClaim = await acquireTestPortBlock({ offsets: [0] });
  claims.push(nativeClaim);
  const nativePort = nativeClaim.port;
  async function startNative() {
    if (remoteNativeUrl) {
      fs.writeFileSync(
        root + "/remote-native-launch.json",
        JSON.stringify({
          url: remoteNativeUrl,
          providerMode: "existing-native",
          nativeConfigurationUnchanged: true,
          workspace: root + "/workspace",
        }),
      );
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const ready = await new Promise((resolve) => {
          const socket = new WebSocket(remoteNativeUrl, {
            ...remoteSocketOptions,
            handshakeTimeout: 5000,
          });
          socket.once("open", () => {
            socket.close();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        });
        if (ready) {
          return { pid: "external-native" };
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
      throw new Error("Isolated remote native did not become ready");
    }
    const child = spawn(binary, ["app-server", "--listen", `ws://127.0.0.1:${nativePort}`], {
      cwd: root + "/workspace",
      env: {
        ...env,
        HOME: root + "/native-home",
        CODEX_HOME: root + "/native-home",
        RUST_LOG: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await new Promise((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error("native startup deadline")), 20000);
      const output = (bytes) => {
        fs.appendFileSync(root + "/native.log", bytes);
        seen = (seen + bytes.toString()).slice(-4000);
        if (seen.includes("listening on:")) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("native exited before ready"));
      });
    });
    return child;
  }
  let native = await startNative();
  const cutConnection = (front, back) => {
    front.terminate();
    back.terminate();
    if (mode.includes("outage")) {
      reconnectBlocked = true;
    }
    if (gatewayRestart) {
      // Kill only the fixture Gateway; the native process and SQLite state survive.
      cli.kill("SIGKILL");
    }
    if (mode.includes("restart") && !gatewayRestart) {
      restartPromise = (async () => {
        try {
          const exited = new Promise((resolve) => {
            native.once("exit", resolve);
          });
          native.kill("SIGKILL");
          await exited;
          native = await startNative();
        } catch (error) {
          log("restart-failed", { message: String(error) });
          throw error;
        }
      })();
    }
  };
  proxy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => {
    proxy.once("listening", r);
  });
  let connection = 0;
  proxy.on("connection", (front) => {
    if (reconnectBlocked) {
      front.terminate();
      return;
    }
    const cid = ++connection;
    const back = new WebSocket(
      remoteNativeUrl || `ws://127.0.0.1:${nativePort}`,
      remoteSocketOptions,
    );
    sockets.add(front);
    sockets.add(back);
    const queue = [];
    log("connect", { cid });
    const requestMethods = new Map();
    // Live evidence intentionally excludes config, account payloads, prompts and tool bodies.
    const wireEvidence = (frame, responseTo) => ({
      cid,
      id: frame.id,
      method: frame.method,
      responseTo,
      threadId: frame.params?.threadId ?? frame.params?.thread?.id ?? frame.result?.thread?.id,
      turnId: frame.params?.turnId ?? frame.params?.turn?.id ?? frame.result?.turn?.id,
      status: frame.params?.turn?.status ?? frame.result?.turn?.status,
      tool: frame.params?.tool,
      errorCode: typeof frame.error?.code === "number" ? frame.error.code : undefined,
    });
    front.on("message", (data) => {
      const v = JSON.parse(websocketText(data));
      if (v.method && v.id !== undefined) {
        requestMethods.set(v.id, v.method);
      }
      log("to-native", remoteNativeUrl ? wireEvidence(v) : { cid, ...v });
      if (
        remoteNativeUrl &&
        typeof v.method === "string" &&
        ((v.method.startsWith("account/") &&
          !["account/read", "account/rateLimits/read"].includes(v.method)) ||
          (v.method.startsWith("config/") && v.method !== "config/read"))
      ) {
        blockedRemoteMutation = v.method;
        log("remote-native-mutation-blocked", { method: v.method });
        if (v.id !== undefined) {
          front.send(
            JSON.stringify({
              id: v.id,
              error: {
                code: -32600,
                message: "Fixture forbids shared native account/config mutation",
              },
            }),
          );
        }
        cli?.send({ kind: "stop-live" });
        return;
      }
      if (
        (mode.includes("lost-result") || mode.includes("joint")) &&
        v.id === pendingToolId &&
        !v.method &&
        !faulted
      ) {
        faulted = true;
        log("fault-injected", { kind: "lost-tool-result", cid, id: v.id });
        cutConnection(front, back);
        return;
      }
      if (back.readyState === WebSocket.OPEN) {
        back.send(data, { binary: false });
      } else {
        queue.push(data);
      }
    });
    back.on("open", () => {
      for (const d of queue) {
        back.send(d, { binary: false });
      }
    });
    back.on("message", (data) => {
      const frame = JSON.parse(websocketText(data));
      if (
        !authFailure &&
        !liveSlack &&
        !mode.includes("model-fallback") &&
        frame.method === "turn/completed" &&
        frame.params?.turn?.status === "failed"
      ) {
        failProvider = false;
      }
      const responseTo = frame.method ? undefined : requestMethods.get(frame.id);
      if (!frame.method) {
        requestMethods.delete(frame.id);
      }
      log("from-native", remoteNativeUrl ? wireEvidence(frame, responseTo) : { cid, ...frame });
      if (frame.method === "item/tool/call") {
        const expectedLiveEffect =
          frame.params?.tool === "gateway_exec" &&
          typeof frame.params?.arguments?.command === "string" &&
          frame.params.arguments.command.includes("effect-count.txt");
        if (!liveSlack || !mode.includes("effect") || expectedLiveEffect) {
          pendingToolId = frame.id;
          pendingToolTurnId = frame.params?.turnId;
        }
        if (
          mode.includes("active") &&
          !mode.includes("lost-result") &&
          !lostCompletion &&
          !faulted
        ) {
          faulted = true;
          log("fault-injected", { kind: "undelivered-tool-request", cid, id: frame.id });
          cutConnection(front, back);
          return;
        }
      }
      if (
        lostCompletion &&
        !faulted &&
        pendingToolTurnId &&
        frame.method === "turn/completed" &&
        frame.params?.turn?.id === pendingToolTurnId &&
        frame.params.turn.status === "completed"
      ) {
        faulted = true;
        log("fault-injected", { kind: "lost-completed-turn", cid, turnId: pendingToolTurnId });
        cutConnection(front, back);
        return;
      }
      if (front.readyState === WebSocket.OPEN) {
        front.send(data, { binary: false });
      }
    });
    front.on("close", () => {
      log("disconnect", { cid });
      back.close();
      sockets.delete(front);
    });
    back.on("close", () => {
      front.close();
      sockets.delete(back);
    });
    front.on("error", () => {});
    back.on("error", () => {});
  });
  const config = {
    agents: {
      defaults: {
        skipBootstrap: true,
        model: { primary: "openai/" + model },
        models: { ["openai/" + model]: { agentRuntime: { id: "codex" } } },
      },
      entries: { main: { workspace: root + "/workspace" } },
    },
    models: {
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: "openai-responses",
          auth: "api-key",
          apiKey: "synthetic-local-only",
          models: [
            {
              id: model,
              name: model,
              input: ["text"],
              reasoning: true,
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    plugins: {
      allow: ["openai", "codex"],
      slots: { memory: "none" },
      entries: {
        openai: { enabled: true },
        codex: {
          enabled: true,
          config: {
            appServer: {
              transport: "websocket",
              url: `ws://127.0.0.1:${proxy.address().port}`,
              approvalPolicy: "never",
              sandbox: "read-only",
              requestTimeoutMs: 20000,
              defaultWorkspaceDir: root + "/workspace",
              remoteWorkspaceRoot: root + "/workspace",
            },
            computerUse: { enabled: false },
          },
        },
      },
    },
    logging: { level: "debug", consoleLevel: "debug", file: root + "/runtime.log" },
  };
  delete config.models;
  if (authFailure || mode.includes("model-fallback")) {
    const fallbacks = ["gpt-5.3-codex", "gpt-5.2"];
    config.agents.defaults.model.fallbacks = fallbacks.map((id) => "openai/" + id);
    for (const id of fallbacks) {
      config.agents.defaults.models["openai/" + id] = { agentRuntime: { id: "codex" } };
    }
  }
  if (mode.includes("remote")) {
    config.plugins.entries.codex.config.appServer.url = `ws://managed-devbox.repro.invalid:${proxy.address().port}`;
    config.plugins.entries.codex.config.appServer.authToken = "synthetic-devbox-token";
  }
  if (mode.includes("effect")) {
    config.tools = { exec: { host: "gateway", security: "full", ask: "off" } };
  }
  config.gateway = { mode: "local", auth: { mode: "token", token: "synthetic-gateway-token" } };
  env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  config.agents.defaults.heartbeat = { every: "0m" };
  if (liveSlack) {
    const channel = process.env.OPENCLAW_CODEX_RECOVERY_SLACK_CHANNEL;
    if (!channel) {
      throw new Error("Missing exact test Slack channel");
    }
    env.OC_REPRO_SLACK_SESSION_PREFIX = liveSessionPrefix;
    const ref = (id) => ({ source: "env", provider: "default", id });
    config.channels = {
      slack: {
        enabled: true,
        mode: "socket",
        groupPolicy: "allowlist",
        requireMention: true,
        botToken: ref(process.env.OPENCLAW_CODEX_RECOVERY_SLACK_BOT_ENV),
        appToken: ref(process.env.OPENCLAW_CODEX_RECOVERY_SLACK_APP_ENV),
        channels: {
          [channel]: {
            enabled: true,
            requireMention: true,
            users: [process.env.OPENCLAW_CODEX_RECOVERY_SLACK_USER],
          },
        },
        dm: { enabled: false },
      },
    };
    config.plugins.allow.push("slack");
    config.plugins.entries.slack = { enabled: true };
    config.agents.defaults.silentReply = { group: "allow" };
  }
  delete env.OPENAI_API_KEY;
  fs.writeFileSync(root + "/config.json", JSON.stringify(config, null, 2));
  const startGateway = (recovered = false) => {
    const out = fs.openSync(root + "/openclaw.log", "a");
    const selectedRepo = upgraded ? recoveryRepo : repo;
    const selectedFixture = path.join(selectedRepo, "test/e2e/codex-recovery");
    const child = spawn(
      nodeDir + "/node",
      [
        "--import",
        selectedFixture + "/repro-dns.mjs",
        "--import",
        selectedRepo + "/scripts/tsx.mjs",
        selectedFixture + "/gateway-entry.mts",
      ],
      {
        cwd: selectedRepo,
        env: { ...env, ...(recovered ? { OC_REPRO_GATEWAY_PHASE: "recovered" } : {}) },
        stdio: ["ignore", out, out, "ipc"],
      },
    );
    fs.closeSync(out);
    children.push(child);
    return child;
  };
  cli = startGateway();
  const handleMessage = async (message) => {
    if (message?.kind === "live-probe-failed") {
      log("live-probe-failed", { probeId: message.probeId });
    }
    if (message?.kind === "restore-backend") {
      automaticRecoveryWindowOpen = false;
      reconnectBlocked = false;
      forcePrimaryOverload = false;
      failProvider = false;
      await restartPromise;
      if (authFailure) {
        // The fixture owner restores its own synthetic credential; OpenClaw does not log in.
        const owner = new WebSocket(`ws://127.0.0.1:${nativePort}`);
        sockets.add(owner);
        await new Promise((resolve, reject) => {
          owner.once("open", resolve);
          owner.once("error", reject);
        });
        let id = 0;
        const rpc = (method, params) =>
          new Promise((resolve, reject) => {
            const requestId = ++id;
            const timer = setTimeout(() => reject(new Error("fixture owner auth deadline")), 10000);
            const receive = (bytes) => {
              const reply = JSON.parse(websocketText(bytes));
              if (reply.id !== requestId) {
                return;
              }
              clearTimeout(timer);
              owner.off("message", receive);
              if (reply.error) {
                reject(new Error(reply.error.message));
              } else {
                resolve(reply.result);
              }
            };
            owner.on("message", receive);
            owner.send(JSON.stringify({ id: requestId, method, params }));
          });
        try {
          await rpc("initialize", { clientInfo: { name: "recovery_fixture_owner", version: "1" } });
          owner.send(JSON.stringify({ method: "initialized" }));
          await rpc("account/login/start", { type: "apiKey", apiKey: "synthetic-local-only" });
        } finally {
          owner.close();
        }
        failProvider = false;
        log("fixture-owner-auth-restored", {});
        if (mode.includes("drift")) {
          fs.writeFileSync(root + "/workspace/SOUL.md", "Synthetic persona version B.\n");
          log("post-failure-prompt-drift", {});
        }
      }
      cli.send({ kind: "backend-restored" });
    }
    if (message?.kind === "release-sibling") {
      for (const res of held) {
        sse(res, "SIBLING_OK");
      }
    }
  };
  const attachGatewayMessages = (child) => {
    child.on("message", (message) => {
      void handleMessage(message).catch((/** @type {unknown} */ error) => {
        log("fixture-restore-error", { error: String(error) });
        child.kill("SIGTERM");
      });
    });
  };
  attachGatewayMessages(cli);
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        cli.kill("SIGTERM");
        resolve({ timeout: true });
      },
      liveSlack ? 2400000 : recoveryRepo ? 420000 : 240000,
    );
    const onExit = (code, signal) => {
      if (upgradeRequested) {
        upgradeRequested = false;
        upgraded = true;
        log("gateway-candidate-started", { recoverySource });
        cli = startGateway(true);
        attachGatewayMessages(cli);
        cli.once("exit", onExit);
        return;
      }
      if (gatewayRestart && !gatewayRestarted && faulted && signal === "SIGKILL") {
        gatewayRestarted = true;
        automaticRecoveryWindowOpen = mode.includes("automatic-startup");
        log("gateway-restarted", { nativePid: native.pid });
        cli = startGateway(true);
        attachGatewayMessages(cli);
        cli.once("exit", onExit);
        return;
      }
      if (!liveSlack && gatewayRestarted && recoveryRepo && !upgraded && code === 0) {
        const baseline = JSON.parse(fs.readFileSync(root + "/gateway-results.json", "utf8"));
        if (!baseline[1]?.error || baseline[2]?.result?.status !== "ok") {
          clearTimeout(timer);
          resolve({ baselineReproductionFailed: true, code: 1 });
          return;
        }
        fs.writeFileSync(root + "/baseline-gateway-results.json", JSON.stringify(baseline));
        recoverySource = sourceSnapshot(recoveryRepo);
        upgraded = true;
        log("gateway-candidate-started", { recoverySource });
        cli = startGateway(true);
        attachGatewayMessages(cli);
        cli.once("exit", onExit);
        return;
      }
      clearTimeout(timer);
      resolve({ code, signal });
    };
    cli.once("exit", onExit);
  });
  fs.writeFileSync(
    root + "/result.json",
    JSON.stringify(
      {
        mode,
        source,
        recoverySource,
        nativeVersion: remoteNativeUrl
          ? process.env.OPENCLAW_CODEX_RECOVERY_NATIVE_VERSION
          : execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
        requestCount,
        automaticInferenceRequests,
        providerMode: remoteNativeUrl ? "existing-native" : "synthetic-local",
        authAttempts,
        exit,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, requestCount, exit }));
  assert.deepEqual(sourceSnapshot(), source, "source must remain unchanged during reproduction");
  assert.equal(exit.code, 0, "Gateway fixture must finish and clean up");
  if (upgraded && recoveryRepo) {
    assert.deepEqual(
      sourceSnapshot(recoveryRepo),
      recoverySource,
      "candidate source must remain unchanged",
    );
  }
  if (!liveSlack) {
    const results = JSON.parse(fs.readFileSync(root + "/gateway-results.json", "utf8"));
    const ok = (r) => !r.error && r.result?.status === "ok";
    assert.equal(ok(results[2]), true, "independent conversation must complete");
    if (mode.includes("sibling")) {
      assert.equal(
        JSON.parse(fs.readFileSync(root + "/sibling-result.json", "utf8")).status,
        "ok",
        "live sibling must complete",
      );
    }
    assert.equal(
      ok(results[0]),
      !expectBroken && !authFailure && !mode.includes("restart") && !mode.includes("outage"),
      "original request recovery outcome",
    );
    assert.equal(ok(results[1]), !expectBroken, "same-conversation new request outcome");
    if (mode.includes("automatic-startup") && !expectBroken) {
      const recovery = JSON.parse(fs.readFileSync(root + "/startup-recovery.json", "utf8"));
      assert.equal(recovery.actualInternalContinuation, true);
      assert.equal(recovery.terminalPhase, "error");
      assert.equal(recovery.recoveryClaimCleared, true);
      assert.equal(
        automaticInferenceRequests,
        0,
        "Startup recovery must not start fresh inference",
      );
      assert.equal(
        automaticReplayAttempted,
        false,
        "Unsafe automatic continuation must not reach inference",
      );
      assert.equal(
        requestCount,
        lostCompletion ? 4 : 3,
        "Only the original task and two fresh requests reach inference",
      );
    }
    if (gatewayRestart && !expectBroken) {
      assert.equal(gatewayRestarted, true, "Gateway must be killed and reopened");
      const followupMarker = `RECOVERY_FOLLOWUP_subsequent_${results[1].runId}`;
      const followupRequest = providerRequests.findLast((request) =>
        JSON.stringify(request.input.findLast((item) => item.role === "user") ?? null).includes(
          followupMarker,
        ),
      );
      assert.ok(followupRequest, "the fresh same-conversation request must reach inference");
      for (const type of ["function_call", "function_call_output"]) {
        assert.ok(
          followupRequest.input.some(
            (item) => item.type === type && item.call_id === "call_probe_0",
          ),
          `fresh same-conversation follow-up must retain original ${type}`,
        );
      }
    }
    if (authFailure && mode.includes("drift") && !expectBroken) {
      assert.equal(
        providerRequests.length,
        2,
        "restored same and independent requests reach inference",
      );
      for (const request of providerRequests) {
        const latestPersona = request.input.findLast(
          (item) =>
            item.role === "developer" &&
            JSON.stringify(item.content).includes("Synthetic persona version"),
        );
        assert.ok(
          JSON.stringify(latestPersona?.content ?? []).includes("Synthetic persona version B"),
          "the model must receive the changed developer instructions after credential restoration",
        );
      }
    }
    if (authFailure) {
      assert(
        authAttempts.some((attempt) => attempt.scheme === "none"),
        "reproduce missing native inference auth",
      );
      assert(
        authAttempts.some((attempt) => attempt.scheme === "bearer"),
        "owner-restored auth must reach provider",
      );
    }
    if (mode.includes("effect")) {
      assert.equal(
        fs.readFileSync(root + "/workspace/effect-count.txt", "utf8"),
        "effect\n",
        "tool side effect must execute exactly once",
      );
    }
    const events = fs
      .readFileSync(root + "/agent-events.jsonl", "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    for (const r of results) {
      if (gatewayRestart && r.label === "original") {
        continue; // The killed process cannot emit a terminal event.
      }
      const runId = r.runId ?? r.result?.runId;
      assert(runId, "each request, including failed requests, must retain its logical run id");
      const terminal = events.filter(
        (e) =>
          e.runId === runId && e.stream === "lifecycle" && ["end", "error"].includes(e.data.phase),
      );
      assert.equal(terminal.length, 1, "one terminal event per logical request");
      if (ok(r)) {
        assert.equal(
          terminal[0].data.phase,
          "end",
          "recovered request must not publish final failure",
        );
      }
    }
    if (mode.includes("active") || mode.includes("joint")) {
      assert.equal(faulted, true, "fault injection must execute");
    }
  }
  if (liveSlack) {
    assert.equal(blockedRemoteMutation, undefined, "No shared native account/config mutations");
    if (remoteNativeUrl) {
      assert.equal(requestCount, 0, "Remote native must use its existing real provider");
    }
    assert.equal(faulted, true, "live Slack request must reach the injected tool boundary");
    assert.equal(
      fs.readFileSync(root + "/workspace/effect-count.txt", "utf8"),
      "effect\n",
      "live tool effect must occur exactly once",
    );
  }
  console.log(
    JSON.stringify({
      fixturePassed: true,
      externalSlackAssertionsRequired: liveSlack,
      expectBroken,
      root,
    }),
  );
} finally {
  await restartPromise?.catch(() => {});
  for (const s of sockets) {
    s.terminate();
  }
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGTERM");
    }
  }
  proxy?.close();
  provider?.closeAllConnections();
  provider?.close();
  await Promise.all(
    children.map((c) =>
      c.exitCode === null && c.signalCode === null
        ? new Promise((r) => {
            const t = setTimeout(() => {
              c.kill("SIGKILL");
              r();
            }, 5000);
            c.once("exit", () => {
              clearTimeout(t);
              r();
            });
          })
        : Promise.resolve(),
    ),
  );
  for (const claim of claims) {
    await claim.release();
  }
}
