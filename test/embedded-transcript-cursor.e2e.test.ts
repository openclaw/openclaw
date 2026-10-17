import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  listSessionEntriesCore,
  loadSessionEntry,
} from "../src/config/sessions/session-accessor.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  connectProofClient,
  createModelGatewayProof,
  contentTexts,
  readRequestText,
} from "./helpers/gateway-integration-fixtures.js";
import {
  startOpenAiResponsesModelServer,
  type OpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import type { OpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

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
    const instance = await createModelGatewayProof({
      name: "embedded-transcript-cursor",
      baseUrl: modelServer.baseUrl,
      modelId: "cursor-settlement",
    });
    instances.push(instance);
    await instance.startGateway();

    const client = await connectProofClient(instance, {
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      await runAgentTurn(client, instance, "first cursor turn");
      const storePath = path.join(instance.state.sessionsDir("main"), "sessions.json");
      const target = { agentId: "main", sessionKey: SESSION_KEY, storePath };
      const readSessionId = () =>
        loadSessionEntry({ ...target, readConsistency: "latest" })?.sessionId;
      const waitSessionId = () =>
        vi.waitFor(
          () => {
            const value = readSessionId();
            expect(value).toBeTruthy();
            return expectDefined(value, `session id was not persisted for ${SESSION_KEY}`);
          },
          { interval: 20, timeout: 30_000 },
        );
      const sessionId = await waitSessionId();
      expect(
        listSessionEntriesCore({ agentId: "main", storePath }).map((entry) => entry.sessionKey),
        instance.logs(),
      ).toEqual([SESSION_KEY]);
      const readPage = async (cursor?: string) => {
        const page = await readSessionTranscriptRawDelta({
          ...target,
          sessionId,
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
      expect(reset, instance.logs()).toMatchObject({
        result: { meta: { agentMeta: { sessionId } } },
      });
      expect(await waitSessionId(), instance.logs()).toBe(sessionId);
      await runAgentTurn(client, instance, "post-reset cursor turn");
      const resumed = await readPage(bootstrap.cursor);
      const events = resumed.events.map(({ event }) => asNonArrayRecord(event));
      expect(events).toContainEqual(expect.objectContaining({ type: "reset" }));
      const messageTexts = events.flatMap((event) =>
        event?.type === "message" ? contentTexts(asNonArrayRecord(event.message)?.content) : [],
      );
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
  client: Awaited<ReturnType<typeof connectProofClient>>,
  instance: OpenClawTestInstance,
  message: string,
) {
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

async function startMockModelServer(): Promise<OpenAiResponsesModelServer> {
  let responseCount = 0;
  return startOpenAiResponsesModelServer({
    modelId: "cursor-settlement",
    bindError: "cursor settlement model server did not bind",
    onRequest: async (request, response) => {
      await readRequestText(request);
      responseCount += 1;
      writeOpenAiResponsesText(response, {
        text: `cursor settlement response ${responseCount}`,
        messageId: `cursor-settlement-message-${responseCount}`,
        responseId: `cursor-settlement-response-${responseCount}`,
      });
    },
  });
}
