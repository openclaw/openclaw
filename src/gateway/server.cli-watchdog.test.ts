import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testing } from "../agents/cli-backends.test-support.js";
import { executeDeps } from "../agents/cli-runner/execute-deps.js";
import { cliBackendLog } from "../agents/cli-runner/log.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  CliBackendExecuteContext,
  CliBackendPrepareExecutionContext,
} from "../plugins/cli-backend.types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as agentJobs from "./agent-turn/agent-job.js";
import type { GatewayClient } from "./client.js";
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

function createWatchdogClock() {
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

type WatchdogCase = {
  name: string;
  behavior: "complete" | "stall" | "quiet" | "overall" | "cancel" | "ordered";
  overallSeconds: number;
  quietMs: number;
  freezeMs: number;
  outputFirst: boolean;
  resume: boolean;
};

type WatchdogCompletion = { status: string; endedAt: number; error?: string };

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
  const clock = createWatchdogClock();
  const realClock = executeDeps.watchdogClock;
  let orderedOutputAt: number | undefined;
  let abortedAt: number | undefined;
  let thawedAt: number | undefined;
  let outputs = 0;
  const waitForAgentJob =
    testCase.behavior === "cancel" ? vi.spyOn(agentJobs, "waitForAgentJob") : undefined;
  const log = vi.spyOn(cliBackendLog, "info");

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
  const proof = state.path("proof");
  let gateway: Awaited<ReturnType<typeof gatewayFixture.startGatewayWithClient>> | undefined;
  let pendingCompletion: Promise<WatchdogCompletion> | undefined;
  let controller: ReturnType<typeof spawn> | undefined;
  let controllerExit: Promise<void> | undefined;
  try {
    executeDeps.watchdogClock = clock;
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
const publish = (name, value) => {
  const target = path.join(process.env.CLAUDE_CONFIG_DIR, name);
  fs.writeFileSync(target + ".tmp", JSON.stringify(value));
  fs.renameSync(target + ".tmp", target);
};
if (process.argv.includes("--version")) { console.log("2.1.226 (fixture)"); process.exit(0); }
if (process.argv.includes("auth")) { send({ loggedIn: true }); process.exit(0); }
let sessionId;
let turns = 0;
let resumed = false;
const behavior = ${JSON.stringify(testCase.behavior)};
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
            prepareExecution: async (context: CliBackendPrepareExecutionContext) => {
              const prepared = await backend.prepareExecution?.(context);
              if (!prepared?.execute) {
                throw new Error("Registered CLI backend must provide its execution transport.");
              }
              const execute = prepared.execute;
              return {
                ...prepared,
                async *execute(execution: CliBackendExecuteContext) {
                  execution.abortSignal?.addEventListener(
                    "abort",
                    () => {
                      abortedAt = clock.now();
                    },
                    { once: true },
                  );
                  for await (const event of execute(execution)) {
                    if (
                      event.type === "assistant" &&
                      testCase.behavior === "ordered" &&
                      orderedOutputAt === undefined
                    ) {
                      orderedOutputAt = clock.now();
                      clock.jump(60_000);
                    }
                    yield event;
                    // The consumer has called noteOutput before requesting the next event.
                    if (event.type === "assistant") {
                      outputs++;
                    }
                  }
                },
              };
            },
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
    outputs = 0;
    abortedAt = undefined;
    const acceptedAt = Date.now();
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
    await expect.poll(() => outputs, { timeout: 5_000 }).toBe(1);
    const pulse = async () => {
      const expected = outputs + 1;
      process.kill(ready.pid, "SIGUSR1");
      await expect.poll(() => outputs, { timeout: 5_000 }).toBe(expected);
    };
    const waitForCompletion = (client: GatewayClient) =>
      client.request<WatchdogCompletion>(
        "agent.wait",
        {
          runId: accepted.runId,
          timeoutMs: 50_000,
        },
        { timeoutMs: 55_000 },
      );
    if (testCase.behavior === "cancel") {
      pendingCompletion = waitForCompletion(gateway.client);
      void pendingCompletion.catch(() => {});
      await expect
        .poll(
          () =>
            waitForAgentJob?.mock.calls.some(
              ([params]) => params.runId === accepted.runId && params.source === "chat",
            ),
          { timeout: 5_000 },
        )
        .toBe(true);
      const cancelled = await gateway.client.request("chat.abort", {
        sessionKey,
        runId: accepted.runId,
      });
      expect(cancelled).toMatchObject({ aborted: true, runIds: [accepted.runId] });
    } else if (testCase.behavior === "ordered") {
      clock.advance(0);
      expect(
        log.mock.calls.some(([message]) => message.includes("cli watchdog credited timer gap")),
      ).toBe(true);
      thawedAt = clock.now();
    } else {
      controller = spawn(
        process.execPath,
        [
          path.join(proof, "freeze-tree.cjs"),
          String(process.pid),
          path.join(proof, "freeze-receipt.json"),
          String(ready.pid),
        ],
        {
          detached: true,
          signal,
          stdio: ["ignore", "ignore", "inherit", "ipc"],
          env: { PATH: "/usr/bin:/bin" },
        },
      );
      const ownedController = controller;
      controllerExit = new Promise<void>((resolve, reject) => {
        ownedController.once("error", reject);
        ownedController.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`controller ${code}`)),
        );
      });
      void controllerExit.catch(() => {});
      const stopped = await Promise.race([
        new Promise<unknown>((resolve) => {
          ownedController.once("message", resolve);
        }),
        controllerExit.then(() => {
          throw new Error("Controller exited before stopping the tree");
        }),
      ]);
      expect(stopped).toBe("stopped");
      signal.throwIfAborted();
      clock.jump(testCase.freezeMs);
      thawedAt = clock.now();
      if (!testCase.outputFirst) {
        clock.advance(0);
      }
      expect(abortedAt).toBeUndefined();
      ownedController.send("resume");
      await controllerExit;
      controller = undefined;
      if (testCase.behavior === "complete" || testCase.behavior === "quiet") {
        await expect
          .poll(
            async () =>
              fs.access(path.join(nativeRoot, "resumed.json")).then(
                () => true,
                () => false,
              ),
            { timeout: 5_000 },
          )
          .toBe(true);
      } else {
        await expect.poll(() => outputs, { timeout: 5_000 }).toBe(2);
      }
      if (testCase.outputFirst) {
        clock.advance(0);
      }
      if (testCase.behavior === "complete") {
        clock.advance(250);
        await pulse();
      }
    }
    if (testCase.behavior !== "cancel") {
      gateway.client.stop();
      gateway.client = await gatewayFixture.connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
    }
    if (!["complete", "cancel"].includes(testCase.behavior)) {
      // The overdue one-second tick is active time; only its lateness is credited.
      const remaining =
        testCase.behavior === "quiet" ? 20_000 : testCase.behavior === "overall" ? 39_000 : 40_000;
      for (let elapsed = 0; elapsed < remaining - 1;) {
        const step = Math.min(5_000, remaining - 1 - elapsed);
        clock.advance(step);
        elapsed += step;
        expect(abortedAt).toBeUndefined();
        if (testCase.behavior === "overall" && step === 5_000) {
          await pulse();
        }
      }
      clock.advance(1);
      expect(abortedAt).toBe(clock.now());
    }
    const completed = await (pendingCompletion ?? waitForCompletion(gateway.client));
    expect(completed.endedAt).toBeGreaterThanOrEqual(acceptedAt);
    expect(clock.pending()).toBe(0);
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
        elapsedAfterThaw = (abortedAt ?? Number.NaN) - 60_000 - orderedOutputAt;
      } else {
        const freeze: { stoppedAt: number; resumedAt: number } = JSON.parse(
          await fs.readFile(path.join(proof, "freeze-receipt.json"), "utf8"),
        );
        expect(freeze.resumedAt).toBeGreaterThanOrEqual(freeze.stoppedAt);
        elapsedAfterThaw = (abortedAt ?? Number.NaN) - (thawedAt ?? Number.NaN);
      }
      const expectedRemaining = testCase.behavior === "quiet" ? 20_000 : 40_000;
      expect(elapsedAfterThaw).toBeGreaterThan(expectedRemaining - 5_000);
      expect(elapsedAfterThaw).toBeLessThan(expectedRemaining + 2_000);
      expect(completed.error).toContain(
        testCase.behavior === "overall" ? "exceeded timeout" : "no output for 40s",
      );
    }
  } finally {
    controller?.kill("SIGTERM");
    await controllerExit?.catch(() => {});
    executeDeps.watchdogClock = realClock;
    log.mockRestore();
    waitForAgentJob?.mockRestore();
    try {
      const evidenceRoot = process.env.OPENCLAW_CLI_WATCHDOG_PROOF_DIR;
      if (evidenceRoot) {
        await fs.mkdir(evidenceRoot, { recursive: true });
        await fs.cp(proof, path.join(evidenceRoot, testCase.behavior), { recursive: true });
      }
    } finally {
      testing.resetDepsForTest();
      gateway?.client.stop();
      await pendingCompletion?.catch(() => {});
      try {
        await gateway?.server.close({ reason: "freeze proof complete" });
      } finally {
        await state.cleanup();
      }
    }
  }
}
