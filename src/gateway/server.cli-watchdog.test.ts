import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cliBackendLog } from "../agents/cli-runner/log.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  CliBackendExecuteContext,
  CliBackendPrepareExecutionContext,
} from "../plugins/cli-backend.types.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as gatewayFixture from "./test-helpers.e2e.js";

const FREEZE_CONTROLLER = String.raw`const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const root = Number(process.argv[2]);
const receipt = process.argv[3];
const duration = Number(process.argv[4]);
const outputFirst = process.argv[5] === "true";
const cliPid = Number(process.argv[6]);
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
const stopped = [];
let finished = false;
const record = { root, controller: process.pid, owned, duration, armedAt: Date.now() };
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
setTimeout(() => {
  if (outputFirst) {
    signal(owned.find((entry) => entry.pid === cliPid), "SIGCONT");
    setTimeout(() => { resume(); process.exit(0); }, 500);
  } else {
    resume(); process.exit(0);
  }
}, duration);
fs.writeFileSync(receipt, JSON.stringify(record));
for (const entry of owned.slice().reverse()) {
  signal(entry, "SIGSTOP");
  stopped.push(entry);
}
record.stoppedAt = Date.now();
fs.writeFileSync(receipt, JSON.stringify(record));
`;

type WatchdogCase = {
  name: string;
  behavior: "complete" | "stall" | "quiet" | "overall" | "cancel" | "ordered";
  overallSeconds: number;
  quietMs: number;
  freezeMs: number;
  outputFirst: boolean;
  resume: boolean;
};

const cases: WatchdogCase[] = [
  {
    name: "preserves a fresh CLI reply across a process freeze",
    behavior: "complete",
    overallSeconds: 300,
    quietMs: 40_000,
    freezeMs: 60_000,
    outputFirst: false,
    resume: false,
  },
  {
    name: "ends a resumed CLI stall at the normal quiet deadline after thaw",
    behavior: "stall",
    overallSeconds: 0,
    quietMs: 40_000,
    freezeMs: 60_000,
    outputFirst: true,
    resume: true,
  },
  {
    name: "counts a short process pause against the quiet budget",
    behavior: "quiet",
    overallSeconds: 0,
    quietMs: 40_000,
    freezeMs: 20_000,
    outputFirst: false,
    resume: false,
  },
  {
    name: "preserves the total active budget without hiding its later expiry",
    behavior: "overall",
    overallSeconds: 40,
    quietMs: 120_000,
    freezeMs: 60_000,
    outputFirst: false,
    resume: false,
  },
  {
    name: "keeps the quiet deadline when output precedes an overdue timer",
    behavior: "ordered",
    overallSeconds: 300,
    quietMs: 40_000,
    freezeMs: 0,
    outputFirst: false,
    resume: false,
  },
  {
    name: "still allows chat.abort to cancel the actual CLI turn",
    behavior: "cancel",
    overallSeconds: 300,
    quietMs: 40_000,
    freezeMs: 0,
    outputFirst: false,
    resume: false,
  },
];

describe.skipIf(process.platform === "win32")(
  "CLI watchdog through registered Gateway methods",
  () => {
    it.for(cases)(
      "registered chat.send $name",
      { timeout: 180_000 },
      (testCase, { signal, onTestFinished }) => {
        const work = runWatchdogCase(testCase, signal);
        onTestFinished(() => work);
        return work;
      },
    );
  },
);

async function runWatchdogCase(testCase: WatchdogCase, signal: AbortSignal) {
  const realNow = Date.now;
  let frozenNow: number | undefined;
  let orderedOutputAt: number | undefined;
  let restoreClock: (() => void) | undefined;
  let observedCredit = false;
  const info = cliBackendLog.info.bind(cliBackendLog);
  const log = vi.spyOn(cliBackendLog, "info").mockImplementation((...args) => {
    info(...args);
    if (frozenNow !== undefined && args[0].includes("cli watchdog credited timer gap")) {
      frozenNow = undefined;
      observedCredit = true;
    }
  });
  const { spawn } = await import("node:child_process");
  const { resolveRuntimeCliBackends } = await import("../plugins/cli-backends.runtime.js");
  const { testing } = await import("../agents/cli-backends.test-support.js");

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
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
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
  const proof = state.path("proof");
  let gateway: Awaited<ReturnType<typeof gatewayFixture.startGatewayWithClient>> | undefined;
  try {
    await fs.mkdir(proof);
    await fs.writeFile(path.join(proof, "freeze-tree.cjs"), FREEZE_CONTROLLER);
    const binDir = state.path("bin");
    await fs.mkdir(binDir);
    const nativeRoot = state.path("native");
    await fs.mkdir(nativeRoot);
    const fixture = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
if (process.argv.includes("--version")) { console.log("2.1.226 (fixture)"); process.exit(0); }
if (process.argv.includes("auth")) { send({ loggedIn: true }); process.exit(0); }
let sessionId;
let turns = 0;
let heartbeat;
let resumed = false;
const behavior = ${JSON.stringify(testCase.behavior)};
process.on("SIGCONT", () => {
  if (resumed) return;
  resumed = true;
  if (behavior === "quiet") return;
  const reply = () => send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Preserved reply." }] } });
  const complete = () => {
    reply();
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "resumed.json"), JSON.stringify({ time: Date.now() }));
    if (behavior === "complete") send({ type: "result", subtype: "success", is_error: false, result: "Preserved reply.", session_id: sessionId });
    if (behavior === "overall") heartbeat = setInterval(reply, 5000);
  };
  if (behavior === "complete") setTimeout(complete, 250);
  else complete();
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
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "ready.json"), JSON.stringify({ pid: process.pid, time: Date.now(), turns }));
  }
});`;
    await fs.writeFile(path.join(binDir, "claude"), `#!${process.execPath}\n${fixture}`, {
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
          timeoutSeconds: testCase.overallSeconds,
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
    testing.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        backends.map((backend) =>
          Object.assign({}, backend, {
            ...(testCase.behavior === "ordered"
              ? {
                  prepareExecution: async (context: CliBackendPrepareExecutionContext) => {
                    const prepared = await backend.prepareExecution?.(context);
                    if (!prepared?.execute) {
                      throw new Error(
                        "Registered CLI backend must provide its execution transport.",
                      );
                    }
                    const execute = prepared.execute;
                    return {
                      ...prepared,
                      async *execute(execution: CliBackendExecuteContext) {
                        for await (const event of execute(execution)) {
                          if (event.type === "assistant" && orderedOutputAt === undefined) {
                            orderedOutputAt = realNow();
                            frozenNow = orderedOutputAt + 60_000;
                            const clock = vi
                              .spyOn(Date, "now")
                              .mockImplementation(() => frozenNow ?? realNow() + 60_000);
                            restoreClock = () => clock.mockRestore();
                          }
                          yield event;
                        }
                      },
                    };
                  },
                }
              : {}),
            config: {
              ...backend.config,
              reliability: {
                watchdog: {
                  fresh: { minMs: testCase.quietMs, maxMs: testCase.quietMs },
                  resume: { minMs: testCase.quietMs, maxMs: testCase.quietMs },
                },
              },
            },
          }),
        ),
    });
    const sessionKey = `agent:main:freeze-${randomUUID()}`;
    if (testCase.resume) {
      const warm = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: "Warm up this session",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      const warmResult = await gateway.client.request<{ status: string }>("agent.wait", {
        runId: warm.runId,
        timeoutMs: 15_000,
      });
      expect(warmResult.status).toBe("ok");
    }
    const accepted = await gateway.client.request<{ runId: string; status: string }>("chat.send", {
      sessionKey,
      message: "Reply after resume.",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.status).toBe("started");
    await expect
      .poll(
        async () =>
          fs.access(path.join(nativeRoot, "ready.json")).then(
            () => true,
            () => false,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    signal.throwIfAborted();
    const ready: { pid: number; time: number; turns: number } = JSON.parse(
      await fs.readFile(path.join(nativeRoot, "ready.json"), "utf8"),
    );
    expect(ready.turns).toBe(testCase.resume ? 2 : 1);
    if (testCase.behavior === "cancel") {
      const cancelled = await gateway.client.request("chat.abort", {
        sessionKey,
        runId: accepted.runId,
      });
      expect(cancelled).toMatchObject({ aborted: true, runIds: [accepted.runId] });
    } else if (testCase.behavior === "ordered") {
      await expect.poll(() => observedCredit, { timeout: 5_000 }).toBe(true);
      gateway.client.stop();
      gateway.client = await gatewayFixture.connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
    } else {
      const controller = spawn(
        process.execPath,
        [
          path.join(proof, "freeze-tree.cjs"),
          String(process.pid),
          path.join(proof, "freeze-receipt.json"),
          String(testCase.freezeMs),
          String(testCase.outputFirst),
          String(ready.pid),
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { PATH: "/usr/bin:/bin" },
        },
      );
      await new Promise<void>((resolve, reject) => {
        controller.once("error", reject);
        controller.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`controller ${code}`)),
        );
      });
      gateway.client.stop();
      gateway.client = await gatewayFixture.connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
    }
    const completed = await gateway.client.request<{
      status: string;
      endedAt: number;
      error?: string;
    }>(
      "agent.wait",
      {
        runId: accepted.runId,
        timeoutMs: 50_000,
      },
      { timeoutMs: 55_000 },
    );
    const history = await gateway.client.request("chat.history", { sessionKey });
    await fs.writeFile(
      path.join(proof, "gateway-result.json"),
      JSON.stringify({ accepted, completed, history }, null, 2),
    );
    const timerMessages = log.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes("cli watchdog credited timer gap"));
    await fs.writeFile(path.join(proof, "timer-events.json"), JSON.stringify(timerMessages));
    if (testCase.behavior === "ordered") {
      expect(timerMessages).toHaveLength(1);
      expect(timerMessages[0]).toContain("creditedMs=0");
    }
    if (testCase.behavior === "complete") {
      expect(completed.status).toBe("ok");
      expect(JSON.stringify(history)).toContain("Preserved reply.");
    } else if (testCase.behavior === "cancel") {
      expect(completed.status).not.toBe("timeout");
      expect(JSON.stringify(history)).not.toContain("Preserved reply.");
    } else {
      expect(completed.status).toBe("timeout");
      let elapsedAfterThaw: number;
      if (testCase.behavior === "ordered") {
        if (orderedOutputAt === undefined) {
          throw new Error("Registered CLI transport did not deliver its ordered output.");
        }
        elapsedAfterThaw = completed.endedAt - 60_000 - orderedOutputAt;
      } else {
        const freeze: { resumedAt: number } = JSON.parse(
          await fs.readFile(path.join(proof, "freeze-receipt.json"), "utf8"),
        );
        elapsedAfterThaw = completed.endedAt - freeze.resumedAt;
      }
      const expectedRemaining = testCase.behavior === "quiet" ? 20_000 : 40_000;
      expect(elapsedAfterThaw).toBeGreaterThan(expectedRemaining - 5_000);
      expect(elapsedAfterThaw).toBeLessThan(expectedRemaining + 2_000);
      expect(completed.error).toContain(
        testCase.behavior === "overall" ? "exceeded timeout" : "no output for 40s",
      );
    }
  } finally {
    restoreClock?.();
    log.mockRestore();
    try {
      const evidenceRoot = process.env.OPENCLAW_CLI_WATCHDOG_PROOF_DIR;
      if (evidenceRoot) {
        await fs.mkdir(evidenceRoot, { recursive: true });
        await fs.cp(proof, path.join(evidenceRoot, testCase.behavior), { recursive: true });
      }
    } finally {
      testing.resetDepsForTest();
      gateway?.client.stop();
      try {
        await gateway?.server.close({ reason: "freeze proof complete" });
      } finally {
        await state.cleanup();
      }
    }
  }
}
