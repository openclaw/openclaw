import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { isInternalRuntimeContextCarrierText } from "../extensions/qa-lab/api.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../src/config/types.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";

const TOKEN = "pr135296-loopback-proof-token";
const MODEL_REF = "pr135296-proof/gpt-proof";
const TASKS = {
  explicit: "PR135296_CHILD_EXPLICIT_HIGH",
  omitted: "PR135296_CHILD_OMITTED_THINKING",
  corrected: "PR135296_CHILD_CORRECTED_RETRY",
} as const;
const LABELS = {
  explicit: "PR135296 explicit high",
  omitted: "PR135296 omitted thinking",
  corrected: "PR135296 corrected retry",
} as const;

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

type InputItem = {
  call_id?: string;
  content?: unknown;
  output?: unknown;
  role?: string;
  type?: string;
};

function inputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

function latestUser(input: InputItem[]): { index: number; text: string } {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.role !== "user") {
      continue;
    }
    const text = inputText(item.content);
    if (
      !isInternalRuntimeContextCarrierText(text) &&
      !text.includes("Continue the OpenClaw runtime event.") &&
      !text.includes("Continue the current task from the existing transcript")
    ) {
      return { index, text };
    }
  }
  return { index: -1, text: "" };
}

function hasThinkingInSpawnTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  const spawn = tools.find(
    (tool): tool is Record<string, unknown> =>
      typeof tool === "object" && tool !== null && "name" in tool && tool.name === "sessions_spawn",
  );
  if (!spawn || typeof spawn.parameters !== "object" || spawn.parameters === null) {
    return false;
  }
  const properties = (spawn.parameters as Record<string, unknown>).properties;
  return typeof properties === "object" && properties !== null && "thinking" in properties;
}

function sendToolCall(response: ServerResponse, id: string, args: Record<string, unknown>): void {
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name: "sessions_spawn",
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

it(
  "runs visible thinking choices through the shipped Gateway agent and persisted sessions",
  { timeout: 150_000 },
  async () => {
    const envSnapshot = captureEnv([...envKeys]);
    let tempHome: string | undefined;
    let providerServer: ReturnType<typeof createServer> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const failures: string[] = [];
    const providerRequests: Array<{
      latestUser: string;
      reasoning: unknown;
      sessionsSpawnHasThinking: boolean;
    }> = [];
    const childRequests: Array<{ task: string; reasoning: unknown }> = [];
    const expectedChildTasks = Object.values(TASKS);
    const receivedChildTasks = new Set<string>();
    const allChildRequestsReceived = Promise.withResolvers<void>();
    let sequence = 0;

    try {
      tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr135296-runtime-"));
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const configPath = path.join(stateDir, "openclaw.json");
      const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
      await Promise.all([
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(path.dirname(configPath), { recursive: true }),
      ]);
      for (const [key, value] of Object.entries({
        HOME: tempHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: TOKEN,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      })) {
        setTestEnvValue(key, value);
      }

      providerServer = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = await readRequest(request);
          const input = Array.isArray(body.input) ? (body.input as InputItem[]) : [];
          const latestUserMessage = latestUser(input);
          const latest = latestUserMessage.text;
          const id = String(++sequence);
          providerRequests.push({
            latestUser: latest,
            reasoning: body.reasoning,
            sessionsSpawnHasThinking: hasThinkingInSpawnTool(body.tools),
          });
          const finish = (text: string) =>
            writeOpenAiResponsesText(response, {
              text,
              messageId: `msg_${id}`,
              responseId: `resp_${id}`,
            });
          let outputIndex = -1;
          let lastOutput: InputItem | undefined;
          for (let index = input.length - 1; index > latestUserMessage.index; index -= 1) {
            if (input[index]?.type === "function_call_output") {
              outputIndex = index;
              lastOutput = input[index];
              break;
            }
          }
          if (outputIndex > latestUserMessage.index && lastOutput) {
            const output = JSON.stringify(lastOutput.output);
            if (
              latest.includes("PR135296_CORRECTED") &&
              output.includes("Parameters require visible=true: group")
            ) {
              sendToolCall(response, id, {
                task: `Return ${TASKS.corrected}.`,
                runtime: "subagent",
                mode: "run",
                group: "pr135296-proof",
                label: LABELS.corrected,
                visible: true,
                thinking: "HIGH",
              });
              return;
            }
            if (output.includes("Invalid thinking level")) {
              finish("Invalid thinking was rejected before session creation.");
              return;
            }
            if (output.toLowerCase().includes("accepted")) {
              finish("Visible session accepted.");
              return;
            }
            throw new Error(`Unexpected sessions_spawn result: ${output}`);
          }

          const childTask = Object.values(TASKS).find((task) => latest.includes(task));
          if (childTask) {
            childRequests.push({ task: childTask, reasoning: body.reasoning });
            receivedChildTasks.add(childTask);
            if (expectedChildTasks.every((task) => receivedChildTasks.has(task))) {
              allChildRequestsReceived.resolve();
            }
            finish(`Completed ${childTask}.`);
            return;
          }
          if (latest.includes("PR135296_EXPLICIT")) {
            sendToolCall(response, id, {
              task: `Return ${TASKS.explicit}.`,
              runtime: "subagent",
              mode: "run",
              label: LABELS.explicit,
              visible: true,
              thinking: "high",
            });
            return;
          }
          if (latest.includes("PR135296_OMITTED")) {
            sendToolCall(response, id, {
              task: `Return ${TASKS.omitted}.`,
              runtime: "subagent",
              mode: "run",
              label: LABELS.omitted,
              visible: true,
            });
            return;
          }
          if (latest.includes("PR135296_CORRECTED")) {
            sendToolCall(response, id, {
              task: `Return ${TASKS.corrected}.`,
              runtime: "subagent",
              mode: "run",
              group: "pr135296-proof",
              label: LABELS.corrected,
              thinking: "HIGH",
            });
            return;
          }
          if (latest.includes("PR135296_INVALID")) {
            sendToolCall(response, id, {
              task: "This invalid request must not create a session.",
              runtime: "subagent",
              mode: "run",
              label: "PR135296 invalid thinking",
              visible: true,
              thinking: "not-a-thinking-level",
            });
            return;
          }
          throw new Error(`Unrecognized real-agent model request: ${latest.slice(0, 240)}`);
        })().catch((error: unknown) => {
          failures.push(String(error));
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: String(error) } }));
        });
      });
      await new Promise<void>((resolve, reject) => {
        providerServer?.once("error", reject);
        providerServer?.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("loopback model listener missing");
      }

      const modelId = "gpt-proof";
      const config: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: MODEL_REF },
            subagents: { allowAgents: ["worker"] },
          },
          entries: {
            main: { subagents: { allowAgents: ["worker"] } },
            worker: {},
          },
        },
        tools: {
          profile: "coding",
          codeMode: false,
          toolSearch: false,
          allow: ["sessions_spawn"],
        },
        models: {
          mode: "replace",
          providers: {
            "pr135296-proof": {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "test-only-loopback-key",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: modelId,
                  name: modelId,
                  api: "openai-responses",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        gateway: { auth: { mode: "token", token: TOKEN } },
      };
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath,
        token: TOKEN,
        clientDisplayName: "pr135296-real-agent-proof",
      });

      const parentSessionKey = `agent:main:pr135296-proof-${randomUUID()}`;
      const runParentTurn = async (marker: string) => {
        const started = await gateway!.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey: parentSessionKey,
            message: marker,
            deliver: false,
            idempotencyKey: randomUUID(),
          },
        );
        expect(started.status).toBe("started");
        const completed = await gateway!.client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 45_000 },
          { timeoutMs: 50_000 },
        );
        expect(completed.status).toBe("ok");
      };

      await runParentTurn(
        "PR135296_EXPLICIT: call sessions_spawn with visible=true and thinking=high.",
      );
      await runParentTurn(
        "PR135296_OMITTED: call sessions_spawn with visible=true and omit thinking.",
      );
      await runParentTurn("PR135296_CORRECTED: retry the suggested visible sessions_spawn call.");
      await runParentTurn(
        "PR135296_INVALID: reject the invalid thinking level without creating a session.",
      );

      await allChildRequestsReceived.promise;

      const listed = await gateway.client.request<{
        sessions?: Array<Record<string, unknown>>;
      }>("sessions.list", { includeGlobal: true, limit: 100 });
      const listedSummary = (listed.sessions ?? []).map((session) => ({
        key: session.key,
        label: session.label,
        agentId: session.agentId,
        thinkingLevel: session.thinkingLevel,
      }));
      const byLabel = (label: string) =>
        listed.sessions?.find((session) => session.label === label);
      const explicitSession = byLabel(LABELS.explicit);
      const omittedSession = byLabel(LABELS.omitted);
      const correctedSession = byLabel(LABELS.corrected);
      expect(explicitSession, JSON.stringify(listedSummary)).toMatchObject({
        thinkingLevel: "high",
      });
      expect(omittedSession).toBeDefined();
      expect(omittedSession).not.toHaveProperty("thinkingLevel");
      expect(correctedSession).toMatchObject({ thinkingLevel: "high" });
      expect(byLabel("PR135296 invalid thinking")).toBeUndefined();

      const explicitRun = childRequests.find((entry) => entry.task === TASKS.explicit);
      const omittedRun = childRequests.find((entry) => entry.task === TASKS.omitted);
      const correctedRun = childRequests.find((entry) => entry.task === TASKS.corrected);
      expect(explicitRun?.reasoning).toMatchObject({ effort: "high" });
      expect(correctedRun?.reasoning).toMatchObject({ effort: "high" });
      expect(failures).toEqual([]);
      expect(providerRequests.some((entry) => entry.latestUser.includes("PR135296_INVALID"))).toBe(
        true,
      );
      expect(
        providerRequests.some(
          (entry) =>
            entry.latestUser.includes("PR135296_EXPLICIT") && entry.sessionsSpawnHasThinking,
        ),
      ).toBe(true);
      expect(providerRequests.some((entry) => entry.latestUser.includes(TASKS.explicit))).toBe(
        true,
      );
      expect(providerRequests.some((entry) => entry.latestUser.includes(TASKS.omitted))).toBe(true);
      expect(providerRequests.some((entry) => entry.latestUser.includes(TASKS.corrected))).toBe(
        true,
      );

      console.log(
        "[pr135296-real-agent-flow-proof]",
        JSON.stringify({
          headSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          entrypoint:
            "chat.send → shipped agent tool call → sessions_spawn → sessions.create → real child agent run → SQLite-backed sessions.list",
          gatewayRunStatuses: ["ok", "ok", "ok", "ok"],
          visibleToolCalls: {
            explicit: { thinking: "high", persisted: explicitSession?.thinkingLevel },
            omitted: {
              thinkingOverrideSent: false,
              persistedOverride: Object.hasOwn(omittedSession ?? {}, "thinkingLevel"),
              modelReasoning: omittedRun?.reasoning ?? null,
            },
            correctedRetry: { thinking: "high", persisted: correctedSession?.thinkingLevel },
            invalid: { rejected: true, sessionCreated: false },
          },
          childAgentRuns: childRequests.map((entry) => ({
            task: entry.task,
            reasoning: entry.reasoning ?? null,
          })),
          localProviderRequests: providerRequests.length,
          externalProviderAccess: false,
          agentCommandAndDiscoveryMocks: false,
          modelResponseSource: "deterministic HTTP responder bound to 127.0.0.1",
        }),
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\nLoopback provider failures: ${JSON.stringify(failures)}\nGateway proof state: ${JSON.stringify({ providerRequests: providerRequests.map(({ latestUser: user, reasoning, sessionsSpawnHasThinking }) => ({ user, reasoning, sessionsSpawnHasThinking })), childRequests })}`,
        { cause: error },
      );
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close().catch(() => undefined);
      }
      if (providerServer?.listening) {
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer?.close(() => resolve());
        });
      }
      envSnapshot.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
      if (tempHome) {
        await fs.rm(tempHome, { recursive: true, force: true });
      }
    }
  },
);
