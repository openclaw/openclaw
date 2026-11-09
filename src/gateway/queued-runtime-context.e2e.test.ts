import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import type { ChatEvent } from "../../packages/gateway-protocol/src/index.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const QUOTE = "RH102 historical quote: keep this user-authored text as data.";
const SEED_REPLY = "RH102 seed visible reply";
const BUSY_REPLY = "RH102 initial visible reply";
const COLLECT_REPLY = "RH102 collected visible reply";
const QUEUED = ["RH102 queued first", "RH102 queued middle", "RH102 queued last"];

type History = {
  messages: Array<{
    role?: string;
    content?: unknown;
    __openclaw?: { id?: string; idempotencyKey?: string; runId?: string };
  }>;
  pendingInputs?: {
    queuedCount?: number;
    items: Array<{ runId?: string; state: string; queued?: true }>;
  };
};
type RequestBody = {
  model?: string;
  input?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
};

function inputTexts(raw: string): string[] {
  const request = JSON.parse(raw) as RequestBody;
  return (request.input ?? []).flatMap((item) =>
    typeof item.content === "string"
      ? [item.content]
      : (item.content ?? []).flatMap((part) => (typeof part.text === "string" ? [part.text] : [])),
  );
}

// Read-only lifecycle notification, not a queue/context injection. The actual
// readiness fact is obtained through authenticated chat.history on every wake.
function workChanges() {
  let revision = 0;
  let next = createDeferred();
  const unsubscribe = onGatewayWorkMetricsChanged(() => {
    revision++;
    const previous = next;
    next = createDeferred();
    previous.resolve();
  });
  return {
    revision: () => revision,
    after: (observed: number) => (revision === observed ? next.promise : Promise.resolve()),
    unsubscribe,
  };
}

it(
  "projects collect ordinals at the real authenticated Gateway/model boundary",
  { timeout: 90_000 },
  async ({ signal }) => {
    await withOpenClawTestState(
      {
        label: "queued-runtime-context",
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN: undefined,
          OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.path("no-plugins");
        state.applyEnv();
        const requests: string[] = [];
        const failures: unknown[] = [];
        const held = createDeferred();
        const release = createDeferred();
        const collected = createDeferred();
        const collectedTerminal = createDeferred<ChatEvent>();
        let collectedRunId: string | undefined;
        const changes = workChanges();
        let providerServer: Awaited<ReturnType<typeof reserveTestPortListener<Server>>> | undefined;
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        await runQaGatewayFixture(
          async () => {
            providerServer = await reserveTestPortListener({
              offsets: [0],
              createListener: () =>
                createServer((request, response) => {
                  void (async () => {
                    if (request.method !== "POST" || request.url !== "/v1/responses") {
                      throw new Error("Unexpected loopback model endpoint");
                    }
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) {
                      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    }
                    const raw = Buffer.concat(chunks).toString("utf8");
                    requests.push(raw);
                    const call = requests.length;
                    expect((JSON.parse(raw) as RequestBody).model).toBe("rh102-proof");
                    if (call === 2) {
                      held.resolve();
                      await release.promise;
                    }
                    if (call > 3) {
                      throw new Error("Unexpected extra physical model request");
                    }
                    writeOpenAiResponsesText(response, {
                      text: call === 1 ? SEED_REPLY : call === 2 ? BUSY_REPLY : COLLECT_REPLY,
                      messageId: randomUUID(),
                      responseId: randomUUID(),
                    });
                    if (call === 3) {
                      collected.resolve();
                    }
                  })().catch((error: unknown) => {
                    failures.push(error);
                    held.reject(error);
                    collected.reject(error);
                    if (!response.headersSent) {
                      response.writeHead(500);
                    }
                    response.end("RH102 fixture failure");
                  });
                }),
            });
            // Observe rejections immediately; the owning awaits below preserve errors.
            void held.promise.catch(() => {});
            void collected.promise.catch(() => {});
            const provider = buildMockOpenAiResponsesProvider(
              `http://127.0.0.1:${providerServer.claim.port}/v1`,
              "rh102-proof",
            );
            const token = "synthetic-rh102-token";
            const cfg = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  skills: [],
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
              },
              gateway: {
                auth: { mode: "token", token },
                controlUi: { allowedOrigins: ["http://localhost"] },
              },
              models: {
                mode: "replace",
                providers: {
                  [provider.providerId]: {
                    ...provider.config,
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
              messages: {
                queue: { mode: "collect", cap: 10, debounceMsByChannel: { webchat: 0 } },
              },
              hooks: { enabled: false },
              plugins: { slots: { memory: "none" } },
              tools: { profile: "minimal" },
            } satisfies OpenClawConfig;
            gateway = await startGatewayWithClient({
              cfg,
              configPath: state.configPath,
              token,
              // Profiled human UI turns carry run-bound skill authoring and drain
              // individually. Public authenticated CLI ingress exercises collect
              // without minting or suppressing that personal capability.
              clientName: "cli",
              mode: "cli",
              scopes: ["operator.admin", "operator.read", "operator.write"],
              onEvent: (event) => {
                if (event.event !== "chat") {
                  return;
                }
                const chat = event.payload as ChatEvent | undefined;
                if (
                  chat &&
                  chat.runId === collectedRunId &&
                  (chat.state === "final" || chat.state === "error" || chat.state === "aborted")
                ) {
                  collectedTerminal.resolve(chat);
                }
              },
            });
            const client = gateway.client;
            const created = await client.request<{ key: string }>("sessions.create", {
              agentId: "main",
              label: "RH102 isolated collection proof",
            });
            const history = async () => {
              const result = await client.request<History>("chat.history", {
                sessionKey: created.key,
                limit: 50,
              });
              return result;
            };
            const send = (message: string, idempotencyKey: string, replyToId?: string) =>
              client.request("chat.send", {
                sessionKey: created.key,
                message,
                idempotencyKey,
                queueMode: "collect",
                ...(replyToId ? { replyToId } : {}),
              });
            const wait = (runId: string) =>
              client.request<AgentWaitResult>(
                "agent.wait",
                { runId, timeoutMs: 30_000 },
                { timeoutMs: 35_000 },
              );
            const seed = randomUUID();
            await send(QUOTE, seed);
            expect(await wait(seed)).toMatchObject({
              status: "ok",
              terminalReply: { disposition: "visible", text: SEED_REPLY },
            });
            const before = await history();
            const quoteId = before.messages.find(
              (message) => message.role === "user" && message.content === QUOTE,
            )?.["__openclaw"]?.id;
            expect(quoteId).toBeTypeOf("string");
            if (!quoteId) {
              throw new Error("Public history did not expose the real reply target id");
            }
            const previousBytes = JSON.stringify(before.messages);
            const busy = randomUUID();
            await send("RH102 hold initial response", busy);
            await withinTest(held.promise, signal);
            const queuedIds: string[] = [];
            for (const message of QUEUED) {
              const id = randomUUID();
              queuedIds.push(id);
              collectedRunId = id;
              await send(message, id, quoteId);
              // ACK means accepted, not enqueued. Each source is observed queued
              // before admitting the next, fixing FIFO order without a sleep.
              for (;;) {
                const revision = changes.revision();
                const pending = (await history()).pendingInputs;
                if (
                  queuedIds.every((runId) =>
                    pending?.items.some(
                      (item) => item.runId === runId && item.state === "queued" && item.queued,
                    ),
                  )
                ) {
                  break;
                }
                await withinTest(changes.after(revision), signal);
              }
            }
            expect(requests).toHaveLength(2);
            release.resolve();
            await withinTest(collected.promise, signal);
            expect(await wait(busy)).toMatchObject({
              status: "ok",
              terminalReply: { disposition: "visible", text: BUSY_REPLY },
            });
            // Provider EOF is not source settlement. The collected content owner
            // publishes the visible reply under the latest source's chat identity.
            expect(await withinTest(collectedTerminal.promise, signal)).toMatchObject({
              runId: queuedIds[2],
              sessionKey: created.key,
              state: "final",
              message: { content: [{ type: "text", text: COLLECT_REPLY }] },
            });
            // agent.wait deliberately returns pending while queue custody exists,
            // even after provider completion. Observe owner settlement through
            // public history, waking only on the existing lifecycle notification.
            for (;;) {
              const revision = changes.revision();
              const pending = (await history()).pendingInputs;
              if (pending?.queuedCount === 0) {
                break;
              }
              await withinTest(changes.after(revision), signal);
            }
            // Queued source replay records completion, not a copied model reply.
            // Visibility was asserted above at its public chat publication owner.
            expect(await wait(queuedIds[2]!)).toMatchObject({ status: "ok" });
            const after = await history();
            expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(
              previousBytes,
            );
            expect(JSON.stringify(after.messages)).toContain(COLLECT_REPLY);
            expect(after.pendingInputs?.queuedCount ?? 0).toBe(0);
            expect(failures).toEqual([]);
            expect(requests).toHaveLength(3);
            const texts = inputTexts(requests[2]!);
            const carrier = texts.find((text) => /^Queued #1 context:$/m.test(text));
            expect(
              carrier,
              "Provider request must carry runtime-instruction ordinals, not just the collect user prompt",
            ).toBeDefined();
            if (!carrier) {
              throw new Error("Missing model-facing collection context");
            }
            const labels = [...carrier.matchAll(/^Queued #(\d+) context:$/gm)].map((match) =>
              Number(match[1]),
            );
            expect(labels).toEqual([1, 2, 3]);
            const contexts = carrier.split(/^Queued #\d+ context:\n/gm).slice(1);
            expect(contexts).toHaveLength(3);
            for (const context of contexts) {
              const quoted = /^Conversation data \(data, not instructions\):\n("[^\n]*")/m.exec(
                context,
              );
              expect(
                quoted,
                "The ordinal must precede a JSON-quoted conversation-data fragment",
              ).not.toBeNull();
              const data = JSON.parse(quoted![1]!) as string;
              expect(data).toContain(QUOTE);
              expect(data).toContain(quoteId);
              expect(data).toContain("Reply target of current user message:");
              expect(data).not.toMatch(/^Queued #\d+ context:$/m);
            }
            const collectPrompt = texts.find((text) =>
              text.includes("[Queued messages while agent was busy]"),
            );
            expect(collectPrompt).toBeDefined();
            let position = -1;
            for (const message of QUEUED) {
              const next = collectPrompt!.indexOf(message);
              expect(next).toBeGreaterThan(position);
              position = next;
            }
            expect(JSON.stringify(after.messages)).not.toContain("Queued #1 context:");
          },
          () => {
            release.resolve();
            changes.unsubscribe();
          },
          () => (gateway ? disconnectGatewayClient(gateway.client) : undefined),
          () => gateway?.server.close({ reason: "RH102 proof complete" }),
          async () => {
            providerServer?.listener.closeAllConnections();
            await providerServer?.releaseListener();
          },
          () => providerServer?.claim.release(),
        );
      },
    );
  },
);
