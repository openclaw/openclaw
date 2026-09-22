import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, onTestFailed } from "vitest";
import { GatewayClient } from "../../packages/gateway-client/src/index.js";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../infra/ed25519-signature.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

function completeResponse(response: ServerResponse, item?: Record<string, unknown>): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const responseId = `resp_${randomUUID()}`;
  send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
  if (item) {
    send({ type: "response.output_item.added", output_index: 0, item });
    send({ type: "response.output_item.done", output_index: 0, item });
  }
  send({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: item ? [item] : [],
      usage: { input_tokens: 1, output_tokens: item ? 1 : 0, total_tokens: item ? 2 : 1 },
    },
  });
  response.end("data: [DONE]\n\n");
}

describe("Gateway Active Memory", () => {
  it(
    "keeps a grounded but terminally failed recall out of the main prompt",
    { timeout: 90_000 },
    (context) => {
      let instance: OpenClawTestInstance | undefined;
      let client: GatewayClient | undefined;
      let providerServer: ReturnType<typeof createServer> | undefined;
      let providerListening = false;
      let tearingDown = false;
      const providerHandlers = new Set<Promise<void>>();
      const providerErrors: unknown[] = [];
      return runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup, createTempDir }) => {
          signal.throwIfAborted();
          const repoRoot = process.cwd();
          const head = resolveGitHead({ cwd: repoRoot });
          expect(head).toMatch(/^[0-9a-f]{40}$/u);
          // Fail before the process helper can rebuild shared dist or choose source.
          await fs.access(path.join(repoRoot, "dist/index.js"));
          signal.throwIfAborted();
          for (const [file, field] of [
            [BUILD_STAMP_FILE, "head"],
            [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
            ["build-info.json", "commit"],
          ] as const) {
            const metadata = JSON.parse(
              await fs.readFile(path.join(repoRoot, "dist", file), "utf8"),
            ) as Record<string, unknown>;
            signal.throwIfAborted();
            expect(metadata[field], file).toBe(head);
          }
          signal.throwIfAborted();
          const home = createTempDir("openclaw-active-memory-gateway-");
          const workspace = path.join(home, "workspace");
          const memoryFact = "The user's usual lunch is ginger ramen.";
          const mainReply = "ACTIVE_MEMORY_RUNTIME_PROOF_OK";
          const mainRequests: string[] = [];
          const memoryResults: string[] = [];
          let recallRequests = 0;
          let memoryToolIssued = false;
          let phase = "preparing fixture";
          const diagnostics: {
            statusLines?: string[];
            preparedRecallConfig?: Record<string, boolean>;
          } = {};
          let sessionFound = false;
          let modelSelectionLocked = false;
          onTestFailed(() => {
            const gatewayLogs = instance?.logs() ?? "";
            console.info({
              phase,
              fixtureHome: home,
              recallRequests,
              memoryResults: memoryResults.length,
              mainRequests: mainRequests.length,
              preparedRecallConfig: diagnostics.preparedRecallConfig,
              sessionFound,
              modelSelectionLocked,
              recallStatus: diagnostics.statusLines
                ?.find((line) => line.startsWith("🧩 Active Memory: status="))
                ?.slice(0, 240),
              preflightTimeoutObserved: gatewayLogs.includes(
                "active-memory: before_prompt_build preflight timed out",
              ),
              promptBuildFailureObserved: gatewayLogs.includes(
                "active-memory: before_prompt_build failed, skipping memory lookup:",
              ),
              noToolAuthorityObserved: gatewayLogs.includes(
                "active-memory: recall skipped because this prompt has no turn tool authority",
              ),
            });
          });
          const server = createServer((request, response) => {
            const handler = (async () => {
              signal.throwIfAborted();
              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                signal.throwIfAborted();
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              signal.throwIfAborted();
              const raw = Buffer.concat(chunks).toString("utf8");
              const body = JSON.parse(raw) as {
                input?: Array<{ type?: string; output?: unknown }>;
              };
              // Route by the helper's prompt, not request order: empty-turn recovery
              // can make several provider calls before the main turn starts.
              if (raw.includes("You are a memory search agent.")) {
                recallRequests += 1;
                for (const item of body.input ?? []) {
                  if (item.type === "function_call_output") {
                    memoryResults.push(
                      typeof item.output === "string" ? item.output : JSON.stringify(item.output),
                    );
                  }
                }
                if (!memoryToolIssued) {
                  memoryToolIssued = true;
                  completeResponse(response, {
                    type: "function_call",
                    id: "fc_memory_get",
                    call_id: "call_memory_get",
                    name: "memory_get",
                    arguments: JSON.stringify({ path: "MEMORY.md" }),
                    status: "completed",
                  });
                } else {
                  // Exhaust the real incomplete-turn recovery after the real tool
                  // read; do not synthesize a runner result or a plugin failure.
                  completeResponse(response);
                }
                return;
              }
              mainRequests.push(raw);
              completeResponse(response, {
                type: "message",
                id: `msg_${randomUUID()}`,
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: mainReply, annotations: [] }],
              });
            })().catch((error: unknown) => {
              const abortedRequest =
                request.aborted &&
                error instanceof Error &&
                "code" in error &&
                (error.code === "ECONNRESET" ||
                  error.code === "ERR_STREAM_PREMATURE_CLOSE" ||
                  error.code === "ABORT_ERR");
              if (
                (signal.aborted && error === signal.reason) ||
                ((signal.aborted || tearingDown) && abortedRequest)
              ) {
                return;
              }
              providerErrors.push(error);
              if (!signal.aborted && !response.destroyed && !response.writableEnded) {
                response.writeHead(500).end("mock provider failed");
              }
            });
            providerHandlers.add(handler);
            void handler.then(
              () => providerHandlers.delete(handler),
              (error: unknown) => {
                providerErrors.push(error);
                providerHandlers.delete(handler);
              },
            );
          });
          providerServer = server;
          await fs.mkdir(workspace, { recursive: true });
          signal.throwIfAborted();
          await fs.writeFile(path.join(workspace, "MEMORY.md"), `${memoryFact}\n`, "utf8");
          signal.throwIfAborted();
          phase = "starting mock provider";
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              providerListening = true;
              resolve();
            });
          });
          signal.throwIfAborted();
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("mock provider did not bind");
          }
          const provider = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${address.port}/v1`,
            "active-memory-proof",
          );
          const token = `active-memory-${randomUUID()}`;
          const cfg = {
            agents: {
              defaults: {
                workspace,
                skipBootstrap: true,
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
              },
            },
            gateway: { auth: { mode: "token", token } },
            hooks: { enabled: false },
            models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
            memory: { search: { rememberAcrossConversations: false } },
            plugins: {
              allow: ["active-memory", "memory-core", "openai"],
              slots: { memory: "memory-core" },
              entries: {
                "active-memory": {
                  enabled: true,
                  config: {
                    mode: "always",
                    agents: ["main"],
                    allowedChatTypes: ["direct", "explicit"],
                    model: provider.modelRef,
                    toolsAllow: ["memory_get"],
                    logging: true,
                  },
                },
              },
            },
            tools: { profile: "full" },
          } satisfies OpenClawConfig;
          phase = "starting Gateway";
          instance = await createOpenClawTestInstance({
            name: "active-memory-gateway",
            cwd: repoRoot,
            config: cfg,
            gatewayToken: token,
            signal,
            verifyCleanup,
            env: {
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
              OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
            },
          });
          signal.throwIfAborted();
          const preparedConfig = JSON.parse(
            await fs.readFile(instance.configPath, "utf8"),
          ) as OpenClawConfig;
          signal.throwIfAborted();
          const preparedPlugin = preparedConfig.plugins?.entries?.["active-memory"];
          diagnostics.preparedRecallConfig = {
            pluginAllowed: preparedConfig.plugins?.allow?.includes("active-memory") === true,
            pluginEnabled: preparedPlugin?.enabled === true,
            memoryCoreSlot: preparedConfig.plugins?.slots?.memory === "memory-core",
            alwaysMode: preparedPlugin?.config?.mode === "always",
            mainAgent: Array.isArray(preparedPlugin?.config?.agents)
              ? preparedPlugin.config.agents.includes("main")
              : false,
          };
          expect(await instance.entrypoint()).toEqual(["dist/index.js"]);
          signal.throwIfAborted();
          await instance.startGateway();
          signal.throwIfAborted();
          const connected = createDeferred();
          void connected.promise.catch(() => undefined);
          client = new GatewayClient({
            url: instance.url,
            token: instance.gatewayToken,
            clientName: GATEWAY_CLIENT_NAMES.TEST,
            clientVersion: "dev",
            mode: GATEWAY_CLIENT_MODES.TEST,
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            deviceIdentity: generateStoredDeviceIdentity(),
            hostDeps: {
              signDevicePayload: signEd25519Payload,
              publicKeyRawBase64UrlFromPem: publicKeyRawBase64UrlFromEd25519Pem,
            },
            onHelloOk: () => connected.resolve(),
            onConnectError: connected.reject,
            onClose: (code, reason) =>
              connected.reject(new Error(`Gateway closed during connect (${code}): ${reason}`)),
          });
          const abortConnect = () => connected.reject(signal.reason);
          signal.addEventListener("abort", abortConnect, { once: true });
          try {
            signal.throwIfAborted();
            client.start();
            await withTestTimeout(connected.promise, 10_000, "Gateway connect timeout");
          } finally {
            signal.removeEventListener("abort", abortConnect);
          }
          signal.throwIfAborted();
          const sessionKey = "agent:main:main";
          phase = "starting main turn";
          // Interactive chat supplies the finalized turn tool authority that recall requires.
          const accepted = await client.request<{ runId: string; status: string }>(
            "chat.send",
            {
              sessionKey,
              message: "What do I usually have for lunch?",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { signal },
          );
          signal.throwIfAborted();
          expect(accepted.status).toBe("started");
          phase = "waiting for main reply";
          const completed = await client.request<{ status: string }>(
            "agent.wait",
            { runId: accepted.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000, signal },
          );
          signal.throwIfAborted();
          expect(completed.status).toBe("ok");
          phase = "checking recall and main reply";
          const entry = loadSessionEntryReadOnly({
            agentId: "main",
            sessionKey,
            env: instance.env,
            storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
          });
          sessionFound = entry !== undefined;
          modelSelectionLocked = entry?.modelSelectionLocked === true;
          diagnostics.statusLines = entry?.pluginDebugEntries?.find(
            (item) => item.pluginId === "active-memory",
          )?.lines;
          expect(providerErrors).toEqual([]);
          expect(memoryResults).toEqual(
            expect.arrayContaining([expect.stringContaining(memoryFact)]),
          );
          expect(recallRequests).toBeGreaterThan(1);
          expect(diagnostics.statusLines?.join("\n")).toContain("Active Memory: status=failed");
          expect(mainRequests).toHaveLength(1);
          expect(mainRequests[0]).not.toContain("<active_memory_plugin>");
          expect(mainRequests[0]).not.toContain("Please try again.");
          signal.throwIfAborted();
          const history = await client.request<{ messages: unknown[] }>(
            "chat.history",
            { sessionKey },
            { signal },
          );
          signal.throwIfAborted();
          expect(JSON.stringify(history.messages)).toContain(mainReply);
        },
        async () => {
          tearingDown = true;
          await client?.stopAndWait();
        },
        async () => {
          await instance?.cleanup();
        },
        async () => {
          const server = providerServer;
          if (!server || !providerListening) {
            return;
          }
          await runQaGatewayFixture(
            async () => {
              server.closeAllConnections();
              await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
              });
            },
            async () => {
              await Promise.allSettled(providerHandlers);
              if (providerErrors.length > 0) {
                throw new AggregateError(providerErrors, "mock provider handlers failed");
              }
            },
          );
        },
      );
    },
  );
});
