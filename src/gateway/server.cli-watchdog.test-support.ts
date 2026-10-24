import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

export function createWatchdogClock() {
  let now = 0;
  let depth = 0;
  let nativeDepth = 0;
  const nativeNow = Date.now;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timers = new Map<
    Parameters<typeof clearTimeout>[0],
    { at: number; callback: () => void }
  >();
  const run = <T>(work: () => T): T => {
    if (depth > 0) {
      return work();
    }
    depth++;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (nativeDepth > 0 ? nativeNow() : now));
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delayMs, ...args) => {
        if (nativeDepth > 0) {
          return nativeSetTimeout(callback, delayMs, ...args);
        }
        // Use a genuine, already-cleared handle without leaving a native timer running.
        const handle = nativeSetTimeout(() => {}, 0);
        nativeClearTimeout(handle);
        timers.set(handle, { at: now + (delayMs ?? 0), callback: () => callback(...args) });
        return handle;
      });
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
      if (nativeDepth > 0) {
        nativeClearTimeout(handle);
      } else {
        timers.delete(handle);
      }
    });
    try {
      return work();
    } finally {
      clearSpy.mockRestore();
      timeoutSpy.mockRestore();
      nowSpy.mockRestore();
      depth--;
    }
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = [...timers].toSorted(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > target) {
        break;
      }
      const [handle, timer] = next;
      now = Math.max(now, timer.at);
      timers.delete(handle);
      run(timer.callback);
    }
    now = target;
  };
  return {
    now: () => now,
    run,
    native: <T>(work: () => T): T => {
      nativeDepth++;
      try {
        return work();
      } finally {
        nativeDepth--;
      }
    },
    // A suspended event loop observes elapsed time before it can dispatch overdue timers.
    jump: (ms: number) => {
      now += ms;
    },
    advance,
    pending: () => timers.size,
  };
}

const CLI_FIXTURE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createConnection } = require("node:net");
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const publish = (name, value) => {
  const target = path.join(process.env.OPENCLAW_TEST_CLI_RECEIPTS, name);
  fs.writeFileSync(target + ".tmp", JSON.stringify(value));
  fs.renameSync(target + ".tmp", target);
  // Filesystem notifications can coalesce or disappear; signal this completed publication directly.
  const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.OPENCLAW_TEST_CLI_RECEIPT_PORT) });
  socket.on("error", (error) => { console.error(error); process.exit(1); });
  socket.end(name);
};
if (process.argv.includes("--version")) { console.log("2.1.226 (fixture)"); process.exit(0); }
if (process.argv.includes("auth")) { send({ loggedIn: true }); process.exit(0); }
let sessionId;
let turns = 0;
let resumed = false;
const behavior = process.env.OPENCLAW_TEST_CLI_BEHAVIOR;
const reply = (text = "Preserved reply.") => send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const complete = (result) => send({ type: "result", subtype: "success", is_error: false, result, session_id: sessionId });
process.on("SIGCONT", () => {
  if (resumed) return;
  resumed = true;
  publish("resumed.json", { time: Date.now() });
  if (behavior !== "quiet" && behavior !== "complete") reply();
});
// Completion and heartbeat delays use the same scenario clock as the host watchdog.
process.on("SIGUSR1", () => {
  reply();
  if (behavior === "complete") complete("Preserved reply.");
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: [] } } });
  } else if (message.type === "user") {
    turns++;
    const index = process.argv.includes("--resume") ? process.argv.indexOf("--resume") : process.argv.indexOf("--session-id");
    sessionId = process.argv[index + 1];
    if (JSON.stringify(message.message).includes("Warm up this session")) {
      reply("Warm reply.");
      complete("Warm reply.");
      return;
    }
    reply("Working.");
    publish("ready.json", { pid: process.pid, time: Date.now(), turns });
  }
});`;

export async function createWatchdogFixture() {
  const state = await createOpenClawTestState({
    label: "cli-freeze",
    env: {
      PATH: undefined,
      OPENCLAW_PATH_BOOTSTRAPPED: "1",
      CLAUDE_CONFIG_DIR: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "dist/extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
  });
  let gateway: Awaited<ReturnType<typeof gatewayFixture.startGatewayWithClient>> | undefined;
  const cleanup = () =>
    runQaGatewayFixture(
      async () => {
        if (gateway) {
          await gatewayFixture.disconnectGatewayClient(gateway.client);
        }
      },
      async () => {
        await gateway?.server.close({ reason: "freeze proof complete" });
      },
      () => state.cleanup(),
    );
  try {
    const binDir = state.path("bin");
    const nativeRoot = state.path("native");
    await Promise.all([fs.mkdir(binDir), fs.mkdir(nativeRoot)]);
    await fs.writeFile(path.join(binDir, "claude"), `#!${process.execPath}\n${CLI_FIXTURE}`, {
      mode: 0o755,
    });
    setTestEnvValue("PATH", binDir);
    setTestEnvValue("CLAUDE_CONFIG_DIR", nativeRoot);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "anthropic:fixture": {
          type: "token",
          provider: "anthropic",
          token: "synthetic-freeze-token",
        },
      },
    });
    const modelRef = "anthropic/claude-sonnet-4-6";
    const token = "freeze-fixture";
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          utilityModel: "",
          model: { primary: modelRef },
          models: { [modelRef]: { agentRuntime: { id: "claude-cli" } } },
        },
      },
      plugins: {
        enabled: true,
        allow: ["anthropic"],
        entries: {
          anthropic: { enabled: true, config: { sessionCatalog: { enabled: false } } },
        },
        slots: { memory: "none" },
      },
      tools: { profile: "minimal" },
      gateway: { auth: { mode: "token", token } },
    } satisfies OpenClawConfig;
    gateway = await gatewayFixture.startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    await gateway.server.startupSettled;
    const backends = resolveRuntimeCliBackends();
    expect(backends.some((backend) => backend.id === "claude-cli")).toBe(true);
    return { state, gateway, backends, token, cleanup };
  } catch (error) {
    return await runQaGatewayFixture(async () => {
      throw error;
    }, cleanup);
  }
}

export type WatchdogFixture = Awaited<ReturnType<typeof createWatchdogFixture>>;
