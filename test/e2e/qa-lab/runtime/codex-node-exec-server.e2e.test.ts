import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as waitForProofTick } from "node:timers/promises";
import { promisify } from "node:util";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClientOptions } from "../../../../src/gateway/client.js";
import { readGatewayLockProcessCmdline } from "../../../../src/infra/gateway-lock-process.js";
import { isPidDefinitelyDead } from "../../../../src/shared/pid-alive.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../helpers/fixture-receipts.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  approvePairing,
  createChildEnv,
  processIsAlive,
  readNode,
  startNodeProcess,
  stopChild,
  type CapturedChild,
  type GatewayHandle,
} from "./gateway-node-mcp.test-support.js";
import {
  closeWireServer,
  createPublishedWireWorkspace,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const COMMAND = "codex.exec-server.stdio.v1";
const MODEL = "mock-openai/gpt-5.6-luna";
const SESSION_KEY = "agent:qa:codex-node-exec-server-proof";
const SUCCESS_MARKER = "CODEX_NODE_EXEC_SUCCESS_PROOF";
const REPEAT_MARKER = "CODEX_NODE_EXEC_REPEAT_PROOF";
const DISCONNECT_MARKER = "CODEX_NODE_EXEC_DISCONNECT_PROOF";
const RECOVERY_MARKER = "CODEX_NODE_EXEC_FRESH_ATTEMPT_PROOF";
const REQUEST_TIMEOUT_MS = 120_000;
const WAIT_OPTIONS = { timeout: 60_000, interval: 100 };
const WORKER_COMMAND_ARGS = new Set(["worker", "--internal-worker-session"]);
const WORKER_OR_CODEX_COMMAND_ARGS = new Set([...WORKER_COMMAND_ARGS, "codex"]);
const SCENARIO_MARKERS = [
  ["recovery", RECOVERY_MARKER],
  ["repeat", REPEAT_MARKER],
  ["disconnect", DISCONNECT_MARKER],
  ["success", SUCCESS_MARKER],
] as const;
let receipts: FixtureReceiptChannel;

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});

afterAll(async () => {
  await receipts?.close();
});

type ProofScenario = "success" | "repeat" | "disconnect" | "recovery";
type PendingPluginApproval = {
  id: string;
  request?: { pluginId?: string };
};
type NodeStatus = NonNullable<Awaited<ReturnType<typeof readNode>>> & {
  commands?: string[];
  sessionHost?: boolean;
};
type Environment = {
  id?: string;
  status?: string;
  sessionHost?: boolean;
  workerSlots?: { total: number; available: number };
  invocableCommands?: string[];
};
type Session = {
  execCwd?: string;
  spawnedCwd?: string;
  placement?: {
    state?: string;
    remoteWorkspaceDir?: string;
    generation?: number;
    environmentId?: string;
    activeOwnerEpoch?: number;
  };
};

async function readEnvironment(reviewer: GatewayClient, nodeId: string) {
  const inventory = await reviewer.request<{ environments?: Environment[] }>(
    "environments.list",
    {},
  );
  return inventory.environments?.find((entry) => entry.id === `node:${nodeId}`);
}

async function describeSession(gateway: GatewayHandle) {
  return (await gateway.call("sessions.describe", { key: SESSION_KEY })) as { session?: Session };
}

async function pendingCodexApprovals(reviewer: GatewayClient) {
  return (await reviewer.request<PendingPluginApproval[]>("plugin.approval.list", {})).filter(
    (approval) => approval.request?.pluginId === "codex",
  );
}

function waitForTurn(reviewer: GatewayClient, runId: string, timeoutMs = REQUEST_TIMEOUT_MS) {
  return reviewer.request<{ status?: string; error?: string }>(
    "agent.wait",
    { runId, timeoutMs },
    { timeoutMs: timeoutMs + 5_000 },
  );
}
type ProofProvider = Awaited<ReturnType<typeof startProofProvider>>;

function finishProofResponse(response: ServerResponse, item: Record<string, unknown>): void {
  const responseId = `resp_codex_node_${randomUUID()}`;
  writeOpenAiResponsesSse(response, [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 32,
          input_tokens_details: null,
          output_tokens: 16,
          output_tokens_details: null,
          total_tokens: 48,
        },
      },
    },
  ]);
}

function readProofScenario(body: Record<string, unknown>): ProofScenario | undefined {
  const input = Array.isArray(body.input) ? body.input : [];
  for (const entry of input.toReversed()) {
    if (!isRecord(entry) || entry.role !== "user") {
      continue;
    }
    const userText = JSON.stringify(entry);
    const scenario = SCENARIO_MARKERS.find(([, marker]) => userText.includes(marker));
    if (scenario) {
      return scenario[0];
    }
  }
  return undefined;
}

function proofShellCommand(params: {
  scenario: ProofScenario;
  baseUrl: string;
  nodeHome: string;
}): string {
  const evidenceFile =
    params.scenario === "recovery"
      ? "codex-node-recovery.json"
      : params.scenario === "repeat"
        ? "codex-node-repeat.json"
        : "codex-node-proof.json";
  const script =
    params.scenario === "disconnect"
      ? [
          'const fs=require("node:fs");',
          'fs.writeFileSync("codex-node-disconnect.json",JSON.stringify({pid:process.pid}));',
          `import(${JSON.stringify(
            `data:text/javascript;base64,${Buffer.from(
              `${fixtureReceiptClientSource(receipts.endpoint)}\nexport { sendReceipt };`,
            ).toString("base64")}`,
          )}).then(({sendReceipt})=>sendReceipt(${JSON.stringify(DISCONNECT_MARKER)},"started"));`,
          "setInterval(()=>{},1000);",
        ].join("")
      : [
          'const fs=require("node:fs");',
          `fetch(${JSON.stringify(`${params.baseUrl}/proof-http`)})`,
          ".then(async response=>{",
          "const evidence={",
          "openaiKeyPresent:Boolean(process.env.OPENAI_API_KEY),",
          "anthropicKeyPresent:Boolean(process.env.ANTHROPIC_API_KEY),",
          "forgeTokenPresent:Boolean(process.env.GITHUB_TOKEN||process.env.GH_TOKEN),",
          "cloudKeyPresent:Boolean(process.env.AWS_ACCESS_KEY_ID),",
          "gatewayTokenPresent:Boolean(process.env.OPENCLAW_GATEWAY_TOKEN),",
          "runtimeInjectionPresent:Boolean(process.env.NODE_OPTIONS),",
          "ordinary:process.env.NODE_ENV||null,",
          `privateHome:process.env.HOME!==${JSON.stringify(params.nodeHome)},`,
          'privateCodexHome:Boolean(process.env.CODEX_HOME&&process.env.CODEX_HOME.startsWith(process.env.HOME+"/")),',
          "http:await response.text(),pid:process.pid};",
          `fs.writeFileSync(${JSON.stringify(evidenceFile)},JSON.stringify(evidence));`,
          `console.log(${JSON.stringify(params.scenario === "recovery" ? "CODEX_NODE_FRESH_ATTEMPT_OK" : "CODEX_NODE_PROCESS_OK")});`,
          "}).catch(error=>{console.error(error.message);process.exitCode=1});",
        ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

async function startProofProvider(nodeHome: string) {
  const mock = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  let httpHits = 0;
  let nativeExecCalls = 0;
  const visibleTools = new Set<string>();
  let baseUrl = "";
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/proof-http") {
        httpHits += 1;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("CODEX_NODE_HTTP_OK");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const raw = Buffer.concat(chunks);
      if (request.method === "POST" && request.url === "/v1/responses") {
        const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        for (const tool of Array.isArray(body.tools) ? body.tools : []) {
          if (isRecord(tool) && typeof tool.name === "string") {
            visibleTools.add(tool.name);
          }
        }
        const scenario = readProofScenario(body);
        if (scenario) {
          const callId = `call_codex_node_${scenario}`;
          const completed = (Array.isArray(body.input) ? body.input : []).some(
            (entry) =>
              isRecord(entry) && entry.type === "function_call_output" && entry.call_id === callId,
          );
          if (completed) {
            finishProofResponse(response, {
              type: "message",
              role: "assistant",
              id: `msg_codex_node_${scenario}`,
              content: [{ type: "output_text", text: `CODEX_NODE_${scenario.toUpperCase()}_OK` }],
            });
            return;
          }
          nativeExecCalls += 1;
          finishProofResponse(response, {
            type: "function_call",
            call_id: callId,
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: proofShellCommand({ scenario, baseUrl, nodeHome }),
              yield_time_ms: scenario === "disconnect" ? 10_000 : 30_000,
              max_output_tokens: 1_000,
            }),
          });
          return;
        }
      }

      const forwarded = await fetch(`${mock.baseUrl}${request.url ?? "/"}`, {
        method: request.method,
        ...(raw.byteLength ? { body: raw } : {}),
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
          ...(typeof request.headers.session_id === "string"
            ? { session_id: request.headers.session_id }
            : {}),
          ...(typeof request.headers["x-session-affinity"] === "string"
            ? { "x-session-affinity": request.headers["x-session-affinity"] }
            : {}),
        },
      });
      response.writeHead(forwarded.status, Object.fromEntries(forwarded.headers));
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(error instanceof Error ? error.message : "proof provider failed");
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Codex paired-node proof provider did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      baseUrl,
      sessionObserverUrl: mock.sessionObserverUrl,
      get httpHits() {
        return httpHits;
      },
      get nativeExecCalls() {
        return nativeExecCalls;
      },
      visibleTools,
      async stop() {
        const cleanup = await Promise.allSettled([closeWireServer(server), mock.stop()]);
        const failures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(failures, "Codex proof provider cleanup failed");
        }
      },
    };
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await mock.stop();
    throw error;
  }
}

async function connectApprovalReviewer(
  gateway: GatewayHandle,
  onEvent?: GatewayClientOptions["onEvent"],
): Promise<GatewayClient> {
  return acquireGatewayTestClient(
    {
      url: gateway.wsUrl,
      token: gateway.token,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Codex paired-node approval reviewer",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.approvals", "operator.pairing", "operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS],
      deviceIdentity: null,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent,
    },
    {
      timeoutMs: REQUEST_TIMEOUT_MS,
      timeoutMessage: "Codex node approval reviewer connection timed out",
      closeMessage: "approval reviewer closed",
      unrefTimeout: true,
    },
  );
}

async function resolveNextApproval(
  reviewer: GatewayClient,
  decision: "allow-once" | "allow-always" | "deny",
): Promise<void> {
  const pending = await vi.waitFor(
    async () => {
      const [candidate] = await pendingCodexApprovals(reviewer);
      expect(candidate, "expected a pending Codex paired-node approval").toBeDefined();
      return candidate!;
    },
    { timeout: 15_000, interval: 100 },
  );
  expect(pending.request?.pluginId).toBe("codex");
  await reviewer.request("plugin.approval.resolve", { id: pending.id, decision });
}

async function readRemoteEvidence<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function nodeChildCommands(nodePid: number): Promise<string[][]> {
  // Unrelated inline scripts can overflow a whole-host command-line census.
  const { stdout } = await execFileAsync("ps", ["-ax", "-o", "ppid=", "-o", "pid="], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${nodePid} `))
    .flatMap((line) => {
      const pid = Number(line.slice(String(nodePid).length).trim());
      const argv = readGatewayLockProcessCmdline(pid, process.platform, 1_000);
      if (argv?.length) {
        return [argv];
      }
      if (isPidDefinitelyDead(pid)) {
        return [];
      }
      throw new Error(`Could not inspect live node child process ${pid}`);
    });
}

function launchCommandHasArg(argv: string[], names: ReadonlySet<string>): boolean {
  const inlineScript = argv.findIndex(
    (arg) => arg === "-e" || arg === "--eval" || arg.startsWith("--eval="),
  );
  const launchArgs = inlineScript < 0 ? argv : argv.slice(0, inlineScript);
  return launchArgs.some((arg) => {
    const normalized = arg.toLowerCase();
    return names.has(normalized) || names.has(path.basename(normalized));
  });
}

async function startTurn(
  reviewer: GatewayClient,
  marker: string,
  runId = `codex-node-proof-${randomUUID()}`,
): Promise<{ runId: string }> {
  const started = await reviewer.request<{ runId?: string; status?: string }>("chat.send", {
    sessionKey: SESSION_KEY,
    message: marker,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(started).toMatchObject({ runId, status: "started" });
  return { runId };
}

// Native exec may yield before its file write; reconciliation and foreign-PID extinction
// expose no joined test signal. Keep their eventual assertions under the owning test abort.
async function waitForProofState(
  check: () => void | Promise<void>,
  description: string,
  signal: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  try {
    await withinTest(
      (async () => {
        for (;;) {
          signal.throwIfAborted();
          try {
            await check();
            return;
          } catch (error) {
            lastError = error;
          }
          await waitForProofTick(10, undefined, { signal });
        }
      })(),
      signal,
    );
  } catch (error) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`timed out waiting for ${description}${detail}`, { cause: error });
  }
}

async function expectSuccessfulTurn(reviewer: GatewayClient, runId: string): Promise<void> {
  expect(await waitForTurn(reviewer, runId)).toMatchObject({ status: "ok" });
}

describe("Codex paired-device exec-server carrier", () => {
  it(
    "keeps approved native execution on the real node, reconciles files, and never resumes a disconnect",
    { timeout: 360_000 },
    async ({ signal }) => {
      const root = tempDirs.make("openclaw-codex-node-exec-server-");
      const nodeRoot = path.join(root, "node");
      const nodeHome = path.join(nodeRoot, "home");
      const nodeState = path.join(nodeRoot, "state");
      const nodeTmp = path.join(nodeRoot, "tmp");
      const nodeConfigPath = path.join(nodeRoot, "openclaw.json");
      await Promise.all(
        [nodeHome, nodeState, nodeTmp].map(
          async (dir) => await fs.mkdir(dir, { recursive: true, mode: 0o700 }),
        ),
      );

      let provider: ProofProvider | undefined;
      let published: PublishedWireWorkspace | undefined;
      const gatewayOwner = createQaGatewayChild();
      let gateway: GatewayHandle | undefined;
      let requester: GatewayClient | undefined;
      let reviewer: GatewayClient | undefined;
      let node: CapturedChild | undefined;

      const interruptedRunId = `codex-node-proof-${randomUUID()}`;
      const interruptedTurnSettled = createDeferred();
      const runProof = async () => {
        provider = await startProofProvider(nodeHome);
        published = await createPublishedWireWorkspace(path.join(root, "workspace"));
        gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1",
          providerMode: "mock-openai",
          providerBaseUrl: `${provider.baseUrl}/v1`,
          mockSessionObserverUrl: provider.sessionObserverUrl,
          primaryModel: MODEL,
          alternateModel: MODEL,
          forcedRuntime: "codex",
          enabledPluginIds: ["codex"],
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENAI_API_KEY: "codex-node-gateway-fake-canary",
            GITHUB_TOKEN: "codex-node-gateway-fake-forge-canary",
            NODE_ENV: "ordinary-node-process-value",
          },
          mutateConfig: (config) => {
            const gatewayConfig = (config.gateway ??= {});
            const nodes = (gatewayConfig.nodes ??= {});
            nodes.commands = { allow: [COMMAND] };
            nodes.pairing = { ...nodes.pairing, autoApproveLocal: false, sshVerify: false };
            const agents = (config.agents ??= {});
            const defaults = (agents.defaults ??= {});
            (defaults.models ??= {})["openai/gpt-5.6-luna"] = { agentRuntime: { id: "codex" } };
            (config.nodeHost ??= {}).workerRuns = { enabled: true };
            return config;
          },
        });
        requester = await connectApprovalReviewer(gateway, (event) => {
          const payload = event.payload;
          if (
            event.event === "chat" &&
            isRecord(payload) &&
            payload.runId === interruptedRunId &&
            (payload.state === "final" || payload.state === "error" || payload.state === "aborted")
          ) {
            interruptedTurnSettled.resolve();
          }
        });
        reviewer = await connectApprovalReviewer(gateway);

        const nodeConfig: OpenClawConfig = {
          gateway: { mode: "local" },
          plugins: { allow: ["codex"], entries: { codex: { enabled: false } } },
          nodeHost: { workerRuns: { enabled: true }, skills: { enabled: false } },
        };
        await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig)}\n`, { mode: 0o600 });
        const nodeEnv = createChildEnv({
          home: nodeHome,
          tempDir: nodeTmp,
          extra: {
            OPENCLAW_HOME: nodeHome,
            OPENCLAW_STATE_DIR: nodeState,
            OPENCLAW_CONFIG_PATH: nodeConfigPath,
            OPENCLAW_GATEWAY_TOKEN: gateway.token,
            OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
            NODE_ENV: "ordinary-node-process-value",
            OPENAI_API_KEY: "codex-node-device-fake-canary",
            ANTHROPIC_API_KEY: "codex-node-device-fake-anthropic-canary",
            GITHUB_TOKEN: "codex-node-device-fake-forge-canary",
            AWS_ACCESS_KEY_ID: "codex-node-device-fake-cloud-canary",
          },
        });
        const gatewayPort = Number(new URL(gateway.baseUrl).port);
        const restartNode = async () => {
          await stopChild(node);
          return startNodeProcess(gatewayPort, nodeEnv);
        };
        node = startNodeProcess(gatewayPort, nodeEnv);
        const nodeId = await approvePairing(gateway, "device");
        const expectApprovedNode = async () => {
          const approved = (await readNode(gateway!, nodeId)) as NodeStatus | undefined;
          expect(approved).toMatchObject({
            connected: true,
            approvalState: "approved",
            sessionHost: true,
          });
          return approved;
        };
        node = await restartNode();
        await approvePairing(gateway, "node", nodeId);
        await vi.waitFor(async () => {
          const approved = await expectApprovedNode();
          expect(approved?.commands).not.toContain(COMMAND);
        }, WAIT_OPTIONS);

        await gateway.call("sessions.create", {
          key: SESSION_KEY,
          agentId: "qa",
          model: "openai/gpt-5.6-luna",
          worktree: true,
          worktreeName: "codex-node-exec-proof",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        const localSession = await describeSession(gateway);
        const localWorkspace = localSession.session?.execCwd ?? localSession.session?.spawnedCwd;
        expect(localWorkspace).toBeTruthy();

        await vi.waitFor(async () => {
          const environment = await readEnvironment(reviewer!, nodeId);
          expect(environment).toMatchObject({ status: "available", sessionHost: true });
          expect(environment?.workerSlots?.available).toBeGreaterThan(0);
          expect(environment?.invocableCommands ?? []).not.toContain(COMMAND);
        }, WAIT_OPTIONS);
        const unapprovedNodePid = node.child.pid;
        expect(unapprovedNodePid).toBeTruthy();
        await expect(
          gateway.call(
            "sessions.dispatch",
            { key: SESSION_KEY, deviceId: nodeId },
            { timeoutMs: REQUEST_TIMEOUT_MS },
          ),
        ).rejects.toThrow(/codex\.exec-server\.stdio\.v1|enabled|approved|command/iu);
        const rejectedSession = await describeSession(gateway);
        expect(rejectedSession.session?.placement).toEqual(localSession.session?.placement);
        expect(await pendingCodexApprovals(reviewer)).toEqual([]);
        expect(
          (await nodeChildCommands(unapprovedNodePid!)).filter((command) =>
            launchCommandHasArg(command, WORKER_OR_CODEX_COMMAND_ARGS),
          ),
        ).toEqual([]);
        expect(provider.nativeExecCalls).toBe(0);

        nodeConfig.plugins!.entries!.codex!.enabled = true;
        await fs.writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig)}\n`, { mode: 0o600 });
        node = await restartNode();
        await approvePairing(gateway, "node", nodeId);
        node = await restartNode();
        await vi.waitFor(async () => {
          const approved = await expectApprovedNode();
          expect(approved?.commands).toContain(COMMAND);
          expect((await readEnvironment(reviewer!, nodeId))?.invocableCommands).toContain(COMMAND);
        }, WAIT_OPTIONS);

        const dispatched = (await gateway.call(
          "sessions.dispatch",
          { key: SESSION_KEY, deviceId: nodeId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        )) as { placement?: { state?: string; remoteWorkspaceDir?: string } };
        expect(dispatched.placement).toMatchObject({ state: "active" });
        const remoteWorkspace = dispatched.placement?.remoteWorkspaceDir;
        expect(remoteWorkspace).toEqual(expect.any(String));

        const denied = await startTurn(requester, SUCCESS_MARKER);
        await resolveNextApproval(reviewer, "deny");
        const deniedOutcome = await waitForTurn(reviewer, denied.runId);
        expect(deniedOutcome).toMatchObject({ status: "error" });
        expect(provider.nativeExecCalls).toBe(0);
        await expect(
          fs.access(path.join(remoteWorkspace!, "codex-node-proof.json")),
        ).rejects.toThrow();

        const allowed = await startTurn(requester, SUCCESS_MARKER);
        await resolveNextApproval(reviewer, "allow-always");
        await expectSuccessfulTurn(reviewer, allowed.runId);
        expect(provider.visibleTools).toContain("exec_command");
        expect(provider.httpHits).toBe(1);
        const expectedEvidence = {
          openaiKeyPresent: false,
          anthropicKeyPresent: false,
          forgeTokenPresent: false,
          cloudKeyPresent: false,
          gatewayTokenPresent: false,
          runtimeInjectionPresent: false,
          ordinary: "ordinary-node-process-value",
          privateHome: true,
          privateCodexHome: true,
          http: "CODEX_NODE_HTTP_OK",
        };
        const expectEvidence = async (filename: string) => {
          expect(
            await readRemoteEvidence<Record<string, unknown>>(path.join(localWorkspace!, filename)),
          ).toMatchObject(expectedEvidence);
        };
        await waitForProofState(
          () => expectEvidence("codex-node-proof.json"),
          "initial Codex node execution evidence",
          signal,
        );
        const nodePid = node.child.pid;
        expect(nodePid).toBeTruthy();
        expect(
          (await nodeChildCommands(nodePid!)).filter((command) =>
            launchCommandHasArg(command, WORKER_COMMAND_ARGS),
          ),
        ).toEqual([]);

        const repeated = await startTurn(requester, REPEAT_MARKER);
        await expectSuccessfulTurn(reviewer, repeated.runId);
        await waitForProofState(
          () => expectEvidence("codex-node-repeat.json"),
          "repeated Codex node execution evidence",
          signal,
        );
        expect(await pendingCodexApprovals(reviewer)).toEqual([]);
        expect(provider.httpHits).toBe(2);

        await requester.request("sessions.messages.subscribe", { key: SESSION_KEY });
        const interrupted = await startTurn(requester, DISCONNECT_MARKER, interruptedRunId);
        const readStartedProcess = async () => {
          const evidence = await readRemoteEvidence<{ pid?: number }>(
            path.join(remoteWorkspace!, "codex-node-disconnect.json"),
          );
          expect(evidence.pid).toEqual(expect.any(Number));
          expect(processIsAlive(evidence.pid!)).toBe(true);
          return evidence.pid!;
        };
        // Receipts and terminals use separate transports; both confirm the recorded live PID.
        const interruptedProcess = await withinTest(
          Promise.race([
            receipts.waitFor(DISCONNECT_MARKER, "started"),
            interruptedTurnSettled.promise,
          ]).then(readStartedProcess),
          signal,
        );
        const interruptedTerminal = waitForTurn(reviewer, interrupted.runId, 12_000);
        await stopChild(node);
        node = undefined;
        const interruptedOutcome = await interruptedTerminal;
        expect(interruptedOutcome).toMatchObject({ status: "error" });
        expect(interruptedOutcome.error).toMatch(/execution node disconnected.*fresh attempt/iu);
        await waitForProofState(
          () => expect(processIsAlive(interruptedProcess)).toBe(false),
          `interrupted Codex command ${interruptedProcess} to exit`,
          signal,
        );
        await vi.waitFor(async () => {
          expect(await readNode(gateway!, nodeId)).toMatchObject({ connected: false });
        }, WAIT_OPTIONS);

        node = startNodeProcess(gatewayPort, nodeEnv);
        await vi.waitFor(async () => {
          const reconnected = await expectApprovedNode();
          expect(reconnected).toMatchObject({ paired: true });
          expect(reconnected?.commands).toContain(COMMAND);
        }, WAIT_OPTIONS);
        const reconnectPlacement = await describeSession(gateway);
        const moveSource = reconnectPlacement.session?.placement;
        expect(moveSource).toMatchObject({
          generation: expect.any(Number),
          environmentId: expect.any(String),
          activeOwnerEpoch: expect.any(Number),
        });
        if (
          typeof moveSource?.generation !== "number" ||
          typeof moveSource.environmentId !== "string" ||
          typeof moveSource.activeOwnerEpoch !== "number"
        ) {
          throw new Error("reconnected Codex placement omitted exact move-source facts");
        }
        await gateway.call(
          "sessions.move",
          {
            key: SESSION_KEY,
            expected: {
              generation: moveSource.generation,
              environmentId: moveSource.environmentId,
              ownerEpoch: moveSource.activeOwnerEpoch,
            },
            target: { kind: "gateway" },
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        await gateway.call(
          "sessions.dispatch",
          { key: SESSION_KEY, deviceId: nodeId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        const recovered = await startTurn(requester, RECOVERY_MARKER);
        expect(recovered.runId).not.toBe(interrupted.runId);
        await resolveNextApproval(reviewer, "allow-once");
        await expectSuccessfulTurn(reviewer, recovered.runId);
        await waitForProofState(
          async () => {
            await expectEvidence("codex-node-recovery.json");
            expect(
              await readRemoteEvidence<{ pid?: number }>(
                path.join(localWorkspace!, "codex-node-disconnect.json"),
              ),
            ).toMatchObject({ pid: interruptedProcess });
          },
          "recovered Codex node evidence and retained disconnect PID",
          signal,
        );
        expect(provider.httpHits).toBe(3);
      };
      await runQaGatewayFixture(
        runProof,
        () => stopChild(node),
        () => requester?.stopAndWait({ timeoutMs: 5_000 }),
        () => reviewer?.stopAndWait({ timeoutMs: 5_000 }),
        () => stopQaGatewayFixture(gatewayOwner),
        () => (published ? closeWireServer(published.server) : undefined),
        () => provider?.stop(),
      );
    },
  );
});
