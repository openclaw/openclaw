import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
/** Real Gateway/Responses proof: settled write, failed read, rejected call, continuation. */
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { onAgentEvent, type AgentEventPayload } from "../src/infra/agent-events.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { acquireTestPortBlock, type TestPortClaim } from "../src/test-utils/port-claims.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

vi.mock("../src/infra/backoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/infra/backoff.js")>()),
  sleepWithAbort: async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted(),
}));

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

const PROVIDER_ID = "mock-responses";
const MODEL_ID = "synthetic-recovery-model";
const USER_PROMPT = "write my note, then update the config";
// Stable synthetic IDs let the request and tool-lifecycle observations agree.
const WRITE_CALL_ID = "call_write_note";
const WRITE_CONTENT = "ISSUE147040_WRITE_DONE\n";
const TRUNCATED_FRAGMENT = '{"path":"config.json","old_string":"{\\n  \\"port';
const RECOVERED_MARKER = "ISSUE147040_RECOVERED_AFTER_REJECTION";
const TOKEN = "issue147040-proof-token";

type CapturedRequest = {
  method: string;
  url: string;
  stream: unknown;
  messages: unknown[];
};

function responsesSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function responseTurn(turn: number, rejectedResponseStatus: string): string {
  const malformedItemDone = turn === 3 && rejectedResponseStatus.startsWith("item-done-");
  const terminalStatus = rejectedResponseStatus.replace(/^item-done-/, "");
  const call = (id: string, name: string, args: string, status = "completed") => ({
    type: "function_call",
    id: "fc_" + id,
    call_id: id,
    name,
    arguments: args,
    status,
  });
  const message = (text: string) => ({
    type: "message",
    id: "msg_" + turn,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const output =
    turn === 1
      ? [
          message("I am saving the note."),
          call(
            WRITE_CALL_ID,
            "write",
            JSON.stringify({ path: "note.txt", content: WRITE_CONTENT }),
          ),
        ]
      : turn === 2
        ? [call("call_failed_read", "read", JSON.stringify({ path: "missing-proof-file.txt" }))]
        : turn === 3
          ? [
              ...(terminalStatus === "refusal"
                ? [
                    {
                      ...message(""),
                      content: [{ type: "refusal", refusal: "Cannot fulfill this request" }],
                    },
                  ]
                : []),
              call(
                "call_rejected_edit",
                "edit",
                TRUNCATED_FRAGMENT,
                malformedItemDone ? "completed" : "incomplete",
              ),
            ]
          : [message(RECOVERED_MARKER)];
  return responsesSse([
    ...(malformedItemDone
      ? [
          {
            type: "response.output_item.done",
            output_index: 0,
            item: call("call_rejected_edit", "edit", TRUNCATED_FRAGMENT),
          },
        ]
      : []),
    {
      type:
        malformedItemDone && terminalStatus === "failed" ? "response.failed" : "response.completed",
      response: {
        id: "resp_proof_" + turn,
        model: MODEL_ID,
        status:
          turn === 3 && !["refusal", "error"].includes(terminalStatus)
            ? terminalStatus
            : "completed",
        ...(turn === 3 &&
        (terminalStatus === "error" || (malformedItemDone && terminalStatus === "failed"))
          ? { error: { code: "content_filter", message: "Synthetic provider rejection" } }
          : {}),
        output,
        usage: { input_tokens: 640, output_tokens: 20, total_tokens: 660 },
      },
    },
  ]);
}

function buildMockResponsesProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Synthetic recovery model",
    compat: { supportsStore: false },
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "synthetic-proof-key",
    api: "openai-responses",
    request: { allowPrivateNetwork: true },
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("issue #147040 real runtime proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it(
    "continues settled work only after a coherent completed response rejects a tool call",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const toolStarts: AgentEventPayload[] = [];
      const observedEvents: AgentEventPayload[] = [];
      let unsubscribe = () => {};
      let providerClaim: TestPortClaim | undefined;
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      const providerRequests: CapturedRequest[] = [];
      let rejectedResponseStatus = "completed";

      try {
        const tempHome = tempDirs.make("openclaw-issue147040-proof-");
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
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const parsed = JSON.parse(body) as { stream?: unknown; input?: unknown[] };
            providerRequests.push({
              method: request.method ?? "",
              url: request.url ?? "",
              stream: parsed.stream,
              messages: parsed.input ?? [],
            });
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            });
            response.end(responseTurn(providerRequests.length, rejectedResponseStatus));
          });
        });
        providerClaim = await acquireTestPortBlock({ offsets: [0] });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(providerClaim?.port, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockResponsesProvider(`http://127.0.0.1:${providerAddress.port}/v1`);
        const cfg = {
          plugins: { slots: { memory: "none" } },
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
              heartbeat: { every: "0m" },
              skills: [],
            },
            entries: { main: { default: true } },
          },
          tools: { profile: "coding" },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: TOKEN } },
        };

        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: TOKEN,
          clientDisplayName: "issue147040-proof",
        });
        await gateway.server.startupSettled;
        unsubscribe = onAgentEvent((event) => {
          if (event.stream === "tool" && event.data.phase === "start") {
            toolStarts.push(event);
          }
          if (
            event.stream === "lifecycle" ||
            event.stream === "error" ||
            event.stream === "run_status"
          ) {
            observedEvents.push(event);
          }
        });
        for (const status of [
          "completed",
          "failed",
          "cancelled",
          "incomplete",
          "refusal",
          "error",
          // Without terminal drain, even a later coherent completion is unread.
          // Fail closed after committed effects rather than guessing its outcome.
          "item-done-completed",
          "item-done-refusal",
          "item-done-error",
          "item-done-failed",
        ]) {
          await fs.rm(path.join(workspaceDir, "note.txt"), { force: true });
          rejectedResponseStatus = status;
          providerRequests.length = 0;
          toolStarts.length = 0;
          observedEvents.length = 0;
          const sessionKey = `agent:main:issue147040-proof-${status}`;
          const started = await gateway.client.request<{ runId?: string; status?: string }>(
            "chat.send",
            {
              sessionKey,
              message: USER_PROMPT,
              deliver: false,
              idempotencyKey: `issue147040-proof-turn-${status}`,
            },
          );
          expect(started.status).toBe("started");
          const waited = await gateway.client.request<{ status?: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          if (status === "completed") {
            expect(
              waited,
              JSON.stringify({
                requests: providerRequests.length,
                tools: toolStarts.map((event) => event.data.name),
                events: observedEvents.map((event) => ({ stream: event.stream, data: event.data })),
              }),
            ).toMatchObject({ status: "ok" });
          } else {
            expect.soft(waited.status, status).not.toBe("timeout");
          }

          // The committed side effect happened exactly once: the write ran, and the
          // recovery did not replay the prompt or re-run the tool.
          await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe(
            WRITE_CONTENT,
          );

          // The failed read is settled before the rejected edit; only sampling resumes.
          expect(toolStarts.map((event) => event.data.name)).toEqual(["write", "read"]);
          const settledMessages = JSON.stringify(providerRequests[2]?.messages ?? []);
          expect(settledMessages.includes("Successfully wrote")).toBe(true);
          expect(settledMessages.includes("call_failed_read")).toBe(true);
          expect(countOccurrences(settledMessages, USER_PROMPT)).toBe(1);
          if (status !== "completed") {
            expect.soft(providerRequests.length, status).toBe(3);
            const stoppedHistory = await gateway.client.request<{ messages?: unknown[] }>(
              "chat.history",
              { sessionKey, limit: 20 },
            );
            expect
              .soft(
                JSON.stringify(stoppedHistory.messages ?? []).includes(RECOVERED_MARKER),
                status,
              )
              .toBe(false);
            continue;
          }
          expect(
            providerRequests.map(({ method, url, stream }) => ({ method, url, stream })),
          ).toEqual([
            { method: "POST", url: "/v1/responses", stream: true },
            { method: "POST", url: "/v1/responses", stream: true },
            { method: "POST", url: "/v1/responses", stream: true },
            { method: "POST", url: "/v1/responses", stream: true },
          ]);
          // The recovery request continued the current transcript: the settled write
          // result is still there, the prompt appears once, and nothing from the
          // rejected call reached the provider.
          const recoveryMessages = JSON.stringify(providerRequests[3]?.messages ?? []);
          expect(recoveryMessages.includes(`"call_id":"${WRITE_CALL_ID}"`)).toBe(true);
          expect(recoveryMessages.includes('"name":"write"')).toBe(true);
          expect(recoveryMessages.includes("Successfully wrote")).toBe(true);
          expect(recoveryMessages.includes("call_failed_read")).toBe(true);
          const failedRead = providerRequests[3]?.messages.find(
            (item) =>
              isRecord(item) &&
              item.type === "function_call_output" &&
              item.call_id === "call_failed_read",
          );
          if (!isRecord(failedRead) || typeof failedRead.output !== "string") {
            throw new Error("Recovery request omitted the settled read result");
          }
          expect(JSON.parse(failedRead.output)).toMatchObject({ status: "error", tool: "read" });
          expect(countOccurrences(recoveryMessages, USER_PROMPT)).toBe(1);
          expect(recoveryMessages.includes(TRUNCATED_FRAGMENT)).toBe(false);
          expect(recoveryMessages.includes("malformed JSON arguments")).toBe(false);

          const history = await gateway.client.request<{ messages?: unknown[] }>("chat.history", {
            sessionKey,
            limit: 20,
          });
          const serialized = JSON.stringify(history.messages ?? []);
          expect(serialized.includes(RECOVERED_MARKER)).toBe(true);
          expect(serialized.includes("malformed JSON arguments")).toBe(false);
          expect(serialized.includes("incomplete terminal tool call")).toBe(false);
          expect(serialized.includes(TRUNCATED_FRAGMENT)).toBe(false);
        }
      } finally {
        unsubscribe();
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        await providerClaim?.release();
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
