// E2E: ordinary embedded Gateway turns preserve raw transcript cursor continuity.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  listSessionEntriesCore,
  loadSessionEntry,
} from "../src/config/sessions/session-accessor.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
  type OpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const TEST_TIMEOUT_MS = 180_000;
const SESSION_KEY = "agent:main:main";

const instances: OpenClawTestInstance[] = [];
const modelServers: OpenAiResponsesModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

it(
  "resumes a public raw cursor across /new and the next Gateway turn",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const modelServer = await startMockModelServer();
    modelServers.push(modelServer);
    const instance = await createOpenClawTestInstance({
      name: "embedded-transcript-cursor",
      config: createOpenAiResponsesModelConfig({
        baseUrl: modelServer.baseUrl,
        providerId: "cursor-settlement",
        modelId: "cursor-settlement",
        reasoning: false,
        toolProfile: "minimal",
      }),
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    instances.push(instance);
    await instance.startGateway();

    const client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      await runAgentTurn(client, instance, "first cursor turn");
      const storePath = path.join(instance.state.sessionsDir("main"), "sessions.json");
      const sessionId = await waitForSessionId(storePath);
      expect(
        listSessionEntriesCore({ agentId: "main", storePath }).map((entry) => entry.sessionKey),
        instance.logs(),
      ).toEqual([SESSION_KEY]);
      const readPage = async (cursor?: string) => {
        const page = await readSessionTranscriptRawDelta({
          agentId: "main",
          sessionId,
          sessionKey: SESSION_KEY,
          storePath,
          cursor,
          maxBytes: 1_000_000,
          maxEvents: 100,
        });
        expect(page, `${JSON.stringify(page)}\n${instance.logs()}`).toMatchObject({
          kind: "page",
          hasMore: false,
        });
        if (page.kind !== "page") {
          throw new Error(`expected transcript page, got ${page.kind}`);
        }
        return page;
      };
      const bootstrap = await readPage();

      const reset = await runAgentTurn(client, instance, "/new");
      expect(
        (reset as { result?: { meta?: { agentMeta?: { sessionId?: string } } } }).result?.meta
          ?.agentMeta?.sessionId,
        instance.logs(),
      ).toBe(sessionId);
      expect(await waitForSessionId(storePath), instance.logs()).toBe(sessionId);
      await runAgentTurn(client, instance, "post-reset cursor turn");
      const resumed = await readPage(bootstrap.cursor);
      expect(
        resumed.events.some(
          (row) =>
            row.event &&
            typeof row.event === "object" &&
            (row.event as { type?: unknown }).type === "reset",
        ),
      ).toBe(true);
      const messageTexts = resumed.events.flatMap((row) => readMessageText(row.event));
      expect(messageTexts).toContain("post-reset cursor turn");
      expect(messageTexts).toContain("cursor settlement response 2");
      expect(messageTexts).not.toContain("first cursor turn");
      expect(messageTexts).not.toContain("cursor settlement response 1");
    } finally {
      await disconnectGatewayClient(client);
    }
  },
);
async function runAgentTurn(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  instance: OpenClawTestInstance,
  message: string,
): Promise<{ runId?: string; status?: string }> {
  const requestedRunId = randomUUID();
  const started = await client.request<{ runId?: string; status?: string }>("agent", {
    sessionKey: SESSION_KEY,
    message,
    deliver: false,
    idempotencyKey: requestedRunId,
  });
  if (started.status === "ok") {
    return started;
  }
  expect(started.status).toBe("accepted");
  const completed = await client.request<{ error?: unknown; status?: string }>(
    "agent.wait",
    { runId: started.runId ?? requestedRunId, timeoutMs: 120_000 },
    { timeoutMs: 125_000 },
  );
  expect(completed.status, `${JSON.stringify(completed)}\n${instance.logs()}`).toBe("ok");
  return started;
}

async function waitForSessionId(storePath: string): Promise<string> {
  let sessionId: string | undefined;
  await vi.waitFor(
    () => {
      sessionId = loadSessionEntry({
        agentId: "main",
        readConsistency: "latest",
        sessionKey: SESSION_KEY,
        storePath,
      })?.sessionId;
      expect(sessionId).toBeTruthy();
    },
    { interval: 20, timeout: 30_000 },
  );
  if (!sessionId) {
    throw new Error(`session id was not persisted for ${SESSION_KEY}`);
  }
  return sessionId;
}

function readMessageText(event: unknown): string[] {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message") {
    return [];
  }
  const message = (event as { message?: { content?: unknown } }).message;
  if (typeof message?.content === "string") {
    return [message.content];
  }
  if (!Array.isArray(message?.content)) {
    return [];
  }
  return message.content.flatMap((part) =>
    part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [],
  );
}

async function startMockModelServer(): Promise<OpenAiResponsesModelServer> {
  let responseCount = 0;
  return startOpenAiResponsesModelServer({
    modelId: "cursor-settlement",
    bindError: "cursor settlement model server did not bind",
    onRequest: async (request, response) => {
      for await (const chunk of request) {
        void chunk;
      }
      responseCount += 1;
      writeOpenAiResponsesText(response, {
        text: `cursor settlement response ${responseCount}`,
        messageId: `cursor-settlement-message-${responseCount}`,
        responseId: `cursor-settlement-response-${responseCount}`,
      });
    },
  });
}
