import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

const FREEZE_CONTROLLER = String.raw`const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const root = Number(process.argv[2]);
const receipt = process.argv[3];
const cliPid = Number(process.argv[4]);
const identity = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};
if (root !== process.ppid || root <= 1) throw new Error("Controller must own its parent test process");
const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
  .trim().split("\n").map((line) => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    return { pid, parent };
  });
const owned = [{ pid: root, identity: identity(root) }];
for (let index = 0; index < owned.length; index++) {
  owned.push(...rows.filter((row) => row.parent === owned[index].pid && row.pid !== process.pid)
    .map((row) => ({ pid: row.pid, identity: identity(row.pid) })));
}
if (!owned.some((entry) => entry.pid === cliPid)) throw new Error("CLI is not in the owned tree");
const cliTree = [owned.find((entry) => entry.pid === cliPid)];
for (let index = 0; index < cliTree.length; index++) {
  cliTree.push(...rows.filter((row) => row.parent === cliTree[index].pid)
    .map((row) => owned.find((entry) => entry.pid === row.pid)));
}
const stopped = [];
let finished = false;
const record = { root, controller: process.pid, owned, armedAt: Date.now() };
const signal = (entry, name) => {
  if (entry.identity && identity(entry.pid) === entry.identity) process.kill(entry.pid, name);
};
const resume = () => {
  if (finished) return;
  finished = true;
  for (const entry of stopped.slice().reverse()) signal(entry, "SIGCONT");
  record.resumedAt = Date.now();
  fs.writeFileSync(receipt, JSON.stringify(record));
};
process.on("SIGTERM", () => { resume(); process.exit(143); });
process.on("SIGINT", () => { resume(); process.exit(130); });
process.on("exit", resume);
process.on("disconnect", () => { resume(); process.exit(0); });
process.on("message", (message) => {
  if (message === "resume") { resume(); process.exit(0); }
});
fs.writeFileSync(receipt, JSON.stringify(record));
// The test drives the Gateway's clock; its verified CLI tree stops in the OS.
for (const entry of cliTree.slice().reverse()) {
  signal(entry, "SIGSTOP");
  stopped.push(entry);
}
const confirmStopped = () => {
  if (finished) return;
  for (const entry of stopped) {
    const state = execFileSync("/bin/ps", ["-p", String(entry.pid), "-o", "state="], { encoding: "utf8" });
    if (!state.includes("T")) {
      if (state.includes("Z")) throw new Error("Owned CLI exited before stopping");
      setImmediate(confirmStopped);
      return;
    }
  }
  record.stoppedAt = Date.now();
  fs.writeFileSync(receipt, JSON.stringify(record));
  process.send("stopped");
};
confirmStopped();
`;

export function createWatchdogClock() {
  let now = 0;
  const timers = new Map<() => void, { at: number; callback: () => void }>();
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = [...timers].toSorted(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > target) {
        break;
      }
      const [cancel, timer] = next;
      now = Math.max(now, timer.at);
      timers.delete(cancel);
      timer.callback();
    }
    now = target;
  };
  return {
    now: () => now,
    setTimeout: (callback: () => void, delayMs: number) => {
      const cancel = () => {
        timers.delete(cancel);
      };
      timers.set(cancel, { at: now + delayMs, callback });
      return cancel;
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
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const publish = (name, value) => {
  const target = path.join(process.env.OPENCLAW_TEST_CLI_RECEIPTS, name);
  fs.writeFileSync(target + ".tmp", JSON.stringify(value));
  fs.renameSync(target + ".tmp", target);
};
if (process.argv.includes("--version")) { console.log("2.1.226 (fixture)"); process.exit(0); }
if (process.argv.includes("auth")) { send({ loggedIn: true }); process.exit(0); }
let sessionId;
let turns = 0;
let resumed = false;
const behavior = process.env.OPENCLAW_TEST_CLI_BEHAVIOR;
const reply = () => send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Preserved reply." }] } });
process.on("SIGCONT", () => {
  if (resumed) return;
  resumed = true;
  publish("resumed.json", { time: Date.now() });
  if (behavior !== "quiet" && behavior !== "complete") reply();
});
// Completion and heartbeat delays use the same scenario clock as the host watchdog.
process.on("SIGUSR1", () => {
  reply();
  if (behavior === "complete") send({ type: "result", subtype: "success", is_error: false, result: "Preserved reply.", session_id: sessionId });
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
      send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Warm reply." }] } });
      send({ type: "result", subtype: "success", is_error: false, result: "Warm reply.", session_id: sessionId });
      return;
    }
    send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working." }] } });
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
    const controllerScript = state.path("freeze-tree.cjs");
    await fs.writeFile(controllerScript, FREEZE_CONTROLLER);
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
          heartbeat: { every: "0m" },
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
    return { state, gateway, backends, token, controllerScript, cleanup, cleanupFailed: false };
  } catch (error) {
    return await runQaGatewayFixture(async () => {
      throw error;
    }, cleanup);
  }
}

export type WatchdogFixture = Awaited<ReturnType<typeof createWatchdogFixture>>;
