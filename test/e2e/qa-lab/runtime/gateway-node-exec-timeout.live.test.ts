import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  approvePairing,
  createChildEnv,
  processIsAlive,
  startNodeProcess,
  stopChild,
  waitForNode,
  waitForProcessExit,
} from "./gateway-node-mcp.test-support.js";

const LIVE_ENABLED =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_CODEX_NODE_EXEC_TIMEOUT === "1";
const MODEL_REF = "openai/gpt-5.6-luna";
const TURN_TIMEOUT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 3 * 60_000;
const SHORT_PROOF_MS = 105_000;
const LONG_PROOF_MS = 690_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type CommandProof = {
  marker: string;
  home: string;
  pid: number;
  startedAtMs: number;
  observedAtMs: number;
  elapsedMs: number;
};
type CommandCase = {
  name: "default" | "explicit" | "stop" | "process-timeout";
  durationMs: number;
  timeoutSeconds?: number;
};

function quoteShellArg(value: string): string {
  return process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

async function readProof(file: string): Promise<CommandProof> {
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  if (
    !isRecord(value) ||
    typeof value.marker !== "string" ||
    typeof value.home !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.startedAtMs !== "number" ||
    typeof value.observedAtMs !== "number" ||
    typeof value.elapsedMs !== "number"
  ) {
    throw new Error("Node command wrote an invalid proof record");
  }
  return {
    marker: value.marker,
    home: value.home,
    pid: value.pid,
    startedAtMs: value.startedAtMs,
    observedAtMs: value.observedAtMs,
    elapsedMs: value.elapsedMs,
  };
}

async function waitForProof(file: string, timeout: number): Promise<CommandProof> {
  await expect
    .poll(
      () =>
        fs.access(file).then(
          () => true,
          () => false,
        ),
      { timeout, interval: 100 },
    )
    .toBe(true);
  return await readProof(file);
}

function textContent(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return (Array.isArray(message.content) ? message.content : [])
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

async function readCommandHistory(
  gateway: QaGatewayChild,
  sessionKey: string,
  expectedArgs: Record<string, unknown>,
  expectedReply?: string,
) {
  let messages: Record<string, unknown>[] = [];
  let calls: Record<string, unknown>[] = [];
  await expect
    .poll(
      async () => {
        const history = await gateway.call("chat.history", { sessionKey, limit: 100 });
        messages =
          isRecord(history) && Array.isArray(history.messages)
            ? history.messages.filter(isRecord)
            : [];
        calls = messages.flatMap((message) =>
          message.role === "assistant" && Array.isArray(message.content)
            ? message.content
                .filter(isRecord)
                .filter((part) => part.type === "toolCall" && part.name === "node_exec")
            : [],
        );
        return (
          calls.length > 0 &&
          (expectedReply === undefined ||
            (messages.some(
              (message) => message.role === "toolResult" && message.toolCallId === calls[0]?.id,
            ) &&
              messages.some(
                (message) =>
                  message.role === "assistant" && textContent(message).trim() === expectedReply,
              )))
        );
      },
      { timeout: 30_000, interval: 100 },
    )
    .toBe(true);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!isRecord(call) || typeof call.id !== "string") {
    throw new Error("History omitted the node_exec call identity");
  }
  expect(call.arguments).toEqual(expectedArgs);
  return {
    messages,
    result: messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === call.id,
    ),
  };
}

describe.skipIf(!LIVE_ENABLED)("Codex node_exec live timeout ownership", () => {
  it(
    "honors foreground command budgets and stops a zero-timeout node process",
    { timeout: 20 * 60_000 },
    async () => {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for the Codex node_exec live proof");
      }
      const repoRoot = process.cwd();
      const root = tempDirs.make("openclaw-codex-node-exec-timeout-");
      const gatewayParent = path.join(root, "gateway");
      const nodeHome = path.join(root, "node-home");
      const nodeState = path.join(root, "node-state");
      const nodeTemp = path.join(root, "node-tmp");
      const nodeConfigPath = path.join(root, "node.json");
      const proofDir = path.join(nodeHome, "timeout-proof");
      const probePath = path.join(root, "command.mjs");
      const owner = createQaGatewayChild();
      let node: ReturnType<typeof startNodeProcess> | undefined;
      const activeSessions = new Set<string>();
      let gateway: QaGatewayChild | undefined;

      await Promise.all(
        [gatewayParent, nodeState, nodeTemp, proofDir].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      await fs.writeFile(
        probePath,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          "const home = process.env.OPENCLAW_HOME;",
          'if (!home) throw new Error("Node fixture omitted OPENCLAW_HOME");',
          "const [marker, duration] = process.argv.slice(2);",
          "const startedAtMs = Date.now();",
          "const started = performance.now();",
          "const proof = () => ({ marker, home, pid: process.pid, startedAtMs, observedAtMs: Date.now(), elapsedMs: performance.now() - started });",
          "const record = (phase) => {",
          "  const value = proof();",
          '  const file = path.join(home, "timeout-proof", `${marker}.${phase}.json`);',
          "  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));",
          "  fs.renameSync(`${file}.tmp`, file);",
          "  return value;",
          "};",
          'record("started");',
          "if (Number(duration) === 0) {",
          `  setTimeout(() => record("aged"), ${SHORT_PROOF_MS});`,
          "  setInterval(() => {}, 60000);",
          "} else {",
          '  setTimeout(() => console.log(JSON.stringify(record("finished"))), Number(duration));',
          "}",
        ].join("\n"),
      );
      const nodeConfig: OpenClawConfig = {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        tools: { exec: { mode: "full" } },
        nodeHost: { browserProxy: { enabled: false }, skills: { enabled: false } },
      };
      await fs.writeFile(nodeConfigPath, JSON.stringify(nodeConfig), { mode: 0o600 });

      await runQaGatewayFixture(
        async () => {
          gateway = await owner.start({
            repoRoot,
            command: {
              executablePath: process.execPath,
              argsPrefix: ["dist/index.js"],
              cwd: repoRoot,
              tempParentDir: gatewayParent,
              usePackagedPlugins: true,
            },
            transportBaseUrl: "http://127.0.0.1",
            controlUiEnabled: false,
            providerMode: "live-frontier",
            forcedRuntime: "codex",
            primaryModel: MODEL_REF,
            alternateModel: MODEL_REF,
            enabledPluginIds: ["codex"],
            runtimeEnvPatch: { OPENAI_API_KEY: apiKey, OPENCLAW_SKIP_CHANNELS: "1" },
            mutateConfig: (cfg) => ({
              ...cfg,
              agents: {
                ...cfg.agents,
                defaults: {
                  ...cfg.agents?.defaults,
                  timeoutSeconds: TURN_TIMEOUT_MS / 1000,
                  maxConcurrent: 4,
                  mediaModels: undefined,
                  models: { [MODEL_REF]: {} },
                },
                entries: {
                  ...cfg.agents?.entries,
                  qa: {
                    ...cfg.agents?.entries?.qa,
                    tools: { ...cfg.agents?.entries?.qa?.tools, profile: "full" },
                  },
                },
              },
              tools: {
                ...cfg.tools,
                profile: "full",
                toolSearch: false,
                codeMode: false,
                exec: { host: "node", mode: "full", timeoutSeconds: 1800 },
              },
              memory: { search: { enabled: false } },
              plugins: {
                ...cfg.plugins,
                slots: { ...cfg.plugins?.slots, memory: "none" },
                entries: { ...cfg.plugins?.entries, "memory-core": { enabled: false } },
              },
              gateway: {
                ...cfg.gateway,
                nodes: {
                  ...cfg.gateway?.nodes,
                  commands: { allow: ["system.run", "system.run.prepare"] },
                  pairing: { autoApproveLocal: false, sshVerify: false },
                },
              },
            }),
          });
          const gatewayPort = Number(new URL(gateway.baseUrl).port);
          expect(gatewayPort).not.toBe(18_789);
          const nodeEnv = createChildEnv({
            home: nodeHome,
            tempDir: nodeTemp,
            extra: {
              OPENCLAW_HOME: nodeHome,
              OPENCLAW_STATE_DIR: nodeState,
              OPENCLAW_CONFIG_PATH: nodeConfigPath,
              OPENCLAW_GATEWAY_TOKEN: gateway.token,
              OPENCLAW_SKIP_CHANNELS: "1",
              OPENCLAW_SKIP_PROVIDERS: "1",
            },
          });
          expect(nodeEnv).not.toHaveProperty("OPENAI_API_KEY");
          node = startNodeProcess(gatewayPort, nodeEnv);
          const nodeId = await approvePairing(gateway, "device");
          await stopChild(node);
          node = startNodeProcess(gatewayPort, nodeEnv);
          await approvePairing(gateway, "node", nodeId);
          await waitForNode(gateway, nodeId);
          const liveGateway = gateway;

          async function runCase(testCase: CommandCase) {
            const marker = `NODE_EXEC_${testCase.name.replaceAll("-", "_")}_${randomUUID().replaceAll("-", "")}`;
            const sessionKey = `agent:qa:node-exec-timeout-${randomUUID()}`;
            const expectedArgs = {
              command: [process.execPath, probePath, marker, String(testCase.durationMs)]
                .map(quoteShellArg)
                .join(" "),
              node: nodeId,
              ...(testCase.timeoutSeconds !== undefined
                ? { timeoutSeconds: testCase.timeoutSeconds }
                : {}),
            };
            const expectedReply = `${marker}_DONE`;
            activeSessions.add(sessionKey);
            const run = liveGateway.call(
              "agent",
              {
                sessionKey,
                message: [
                  "Execute this synthetic command on the paired node exactly once using node_exec.",
                  `Use exactly these arguments: ${JSON.stringify(expectedArgs)}`,
                  "Use tool discovery if needed. Do not change files, add timeout arguments, run other commands, retry the command, or run it in the background.",
                  testCase.name === "process-timeout"
                    ? `The command is expected to time out. After its tool result returns, reply exactly ${expectedReply}.`
                    : `Wait for the tool result. Only after it succeeds, reply exactly ${expectedReply}.`,
                ].join("\n"),
                deliver: false,
                idempotencyKey: randomUUID(),
              },
              { expectFinal: true, timeoutMs: TURN_TIMEOUT_MS + 30_000 },
            );
            // Observe the RPC immediately while the independent process evidence is pending.
            const outcome = run.then(
              (value) => ({ kind: "result" as const, value }),
              (error: unknown) => ({ kind: "error" as const, error }),
            );
            const prefix = path.join(proofDir, marker);
            const started = await waitForProof(`${prefix}.started.json`, START_TIMEOUT_MS);
            expect(started).toMatchObject({ marker, home: nodeHome });
            expect(started.pid).not.toBe(node?.child.pid);
            console.info(`[node-exec-live] ${testCase.name} started on the paired node`);
            if (testCase.name === "stop") {
              const aged = await waitForProof(`${prefix}.aged.json`, SHORT_PROOF_MS + 30_000);
              expect(aged.pid).toBe(started.pid);
              expect(aged.elapsedMs).toBeGreaterThan(90_000);
              expect(processIsAlive(started.pid)).toBe(true);
              const aborted = await liveGateway.call("chat.abort", { sessionKey });
              expect(aborted).toMatchObject({ ok: true, aborted: true });
              await waitForProcessExit(started.pid);
            }
            const terminal = await outcome;
            if (terminal.kind === "error") {
              throw terminal.error;
            }
            // Aborts omit result metadata; the persisted node_exec call still identifies Codex.
            expect(terminal.value, liveGateway.logs()).toMatchObject(
              testCase.name === "stop"
                ? { status: "timeout", summary: "aborted", stopReason: "rpc" }
                : { status: "ok", result: { meta: { agentMeta: { agentHarnessId: "codex" } } } },
            );
            const history = await readCommandHistory(
              liveGateway,
              sessionKey,
              expectedArgs,
              testCase.name === "stop" ? undefined : expectedReply,
            );
            if (testCase.name !== "stop") {
              if (!history.result) {
                throw new Error("History omitted the completed node_exec result");
              }
              expect(history.result.isError).toBe(testCase.name === "process-timeout");
              expect(textContent(history.result)).toContain(`Node: ${nodeId}`);
              if (testCase.name === "process-timeout") {
                expect(textContent(history.result)).toContain("Command timed out.");
              } else {
                const finished = await readProof(`${prefix}.finished.json`);
                expect(finished).toMatchObject({
                  marker,
                  home: nodeHome,
                  pid: started.pid,
                  startedAtMs: started.startedAtMs,
                });
                expect(finished.elapsedMs).toBeGreaterThan(
                  testCase.name === "explicit" ? 660_000 : 90_000,
                );
                expect(textContent(history.result)).toContain(marker);
                console.info(
                  `[node-exec-live] ${testCase.name} completed after ${Math.round(finished.elapsedMs)}ms`,
                );
              }
              await waitForProcessExit(started.pid);
            }
            if (testCase.name === "stop" || testCase.name === "process-timeout") {
              await expect(fs.access(`${prefix}.finished.json`)).rejects.toMatchObject({
                code: "ENOENT",
              });
              console.info(`[node-exec-live] ${testCase.name} confirmed process extinction`);
            }
            activeSessions.delete(sessionKey);
          }

          await runCase({ name: "process-timeout", durationMs: 60_000, timeoutSeconds: 2 });
          const results = await Promise.allSettled([
            runCase({ name: "default", durationMs: SHORT_PROOF_MS }),
            runCase({ name: "explicit", durationMs: LONG_PROOF_MS, timeoutSeconds: 900 }),
            runCase({ name: "stop", durationMs: 0, timeoutSeconds: 0 }),
          ]);
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Codex node_exec live timeout proof failed");
          }
        },
        async () => {
          const activeGateway = gateway;
          if (!activeGateway) {
            return;
          }
          const results = await Promise.allSettled(
            [...activeSessions].map((sessionKey) =>
              activeGateway.call("chat.abort", { sessionKey }),
            ),
          );
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Live node_exec turn cancellation failed");
          }
        },
        () => stopChild(node),
        () => stopQaGatewayFixture(owner),
      );
    },
  );
});
