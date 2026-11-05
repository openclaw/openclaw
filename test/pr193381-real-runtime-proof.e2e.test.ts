// PR #193381 proof: an accepted chat message whose own turn never started must stay visible
// through the next run's orphan repair, on a real Gateway session, with the repairing turn
// itself recorded through final provider I/O and the persisted history.
//
// The session is left in exactly the linked report's post-failure state (accepted user row
// persisted, own turn never started). The repairing turn is dispatched through the real Gateway
// "agent" RPC, runs the production embedded pipeline (session boundary repair -> prompt assembly
// -> provider transport), and its final provider request is captured on a loopback mock
// Anthropic server. Observable contract: the merged model prompt carries the orphan text exactly
// once, chat.history keeps serving the session with the accepted message as a standalone row,
// the new turn's durable row does not repeat it, and no leaf control is published (no rebuild).
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../src/agents/sessions/session-manager.js";
import { resolveDefaultSessionStorePath } from "../src/config/sessions/paths.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { anthropicTextTurn } from "./anthropic-text-turn.test-support.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);

const PROVIDER_ID = "mock-anthropic";
const MODEL_ID = "claude-opus-5";
const TOKEN = "pr193381-proof-token";
const ORPHAN_TEXT = "PR193381_ACCEPTED_ORPHAN_WAKE";
const NEW_TEXT = "PR193381_SECOND_REQUEST";
const REPLY_MARKER = "PR193381_REPLY_AFTER_MERGED_ORPHAN";
const QUEUED_MARKER_PREFIX = "[Earlier unanswered user message.";

function buildMockAnthropicProvider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Mock Claude Opus 5",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const config: Omit<ModelProviderConfig, "models"> & { models: [ModelDefinitionConfig] } = {
    baseUrl,
    apiKey: "sk-ant-api03-pr193381-proof", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? (part as { text?: unknown }).text : "",
      )
      .filter((text): text is string => typeof text === "string")
      .join("");
  }
  return "";
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

it(
  "keeps an accepted unanswered message visible when the repairing gateway turn reaches the provider",
  { timeout: 120_000 },
  async () => {
    const fixture = await createFixture("openclaw-pr193381-proof-", TOKEN);
    const { workspaceDir, configPath } = fixture;
    const sessionId = "pr193381-orphan";
    const sessionKey = `agent:main:${sessionId}`;
    const target = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: resolveDefaultSessionStorePath("main"),
    };
    let providerServer: ReturnType<typeof createServer> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const providerRequests: Array<{ messages: Array<{ role?: unknown; content?: unknown }> }> = [];

    try {
      // The post-failure state from the report: the message was accepted and persisted,
      // but its own turn never started, so it is the session's trailing leaf.
      await upsertSessionEntryCore(target, { sessionId, updatedAt: Date.now() });
      const seed = await SessionManager.openAsync(target, workspaceDir);
      // The acceptance-shaped idempotency key of a row persisted at chat admission.
      const acceptedIdempotencyKey = "accepted-user:user";
      await seed.appendMessageAsync({
        role: "user",
        content: ORPHAN_TEXT,
        timestamp: Date.now(),
        ...(acceptedIdempotencyKey ? { idempotencyKey: acceptedIdempotencyKey } : {}),
      });

      providerServer = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const parsed = JSON.parse(body) as {
            messages?: Array<{ role?: unknown; content?: unknown }>;
          };
          providerRequests.push({ messages: parsed.messages ?? [] });
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
          response.end(anthropicTextTurn(MODEL_ID, REPLY_MARKER, "msg_pr193381_merged", 640, 12));
        });
      });
      const providerUrl = await listenProofProvider(providerServer);
      const provider = buildMockAnthropicProvider(providerUrl);
      const cfg = fixture.config(provider);

      gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token: TOKEN,
        clientDisplayName: "pr193381-proof",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });

      // Dispatch the repairing turn through the real Gateway agent RPC: it runs the production
      // embedded pipeline (boundary orphan repair -> prompt assembly -> provider transport).
      const started = await gateway.client.request<{ runId?: string; status?: string }>(
        "agent",
        {
          sessionKey,
          message: NEW_TEXT,
          deliver: false,
          idempotencyKey: "pr193381-repairing-turn",
        },
        { expectFinal: false },
      );
      expect(started.status).toBe("accepted");
      const waited = await gateway.client.request<{ status?: string }>(
        "agent.wait",
        { runId: started.runId, timeoutMs: 60_000 },
        { timeoutMs: 65_000 },
      );
      expect(waited).toMatchObject({ status: "ok" });

      // Final provider I/O of the repairing turn: the merged model prompt carries the orphan
      // text exactly once, together with the queued-message marker and the new request.
      expect(providerRequests).toHaveLength(1);
      const providerUserTexts = (providerRequests[0]?.messages ?? [])
        .filter((message) => message.role === "user")
        .map(messageText);
      const orphanCarrying = providerUserTexts.filter((text) => text.includes(ORPHAN_TEXT));
      expect(orphanCarrying).toHaveLength(1);
      expect(orphanCarrying[0]).toContain(QUEUED_MARKER_PREFIX);
      expect(orphanCarrying[0]).toContain(NEW_TEXT);
      expect(countOccurrences(orphanCarrying[0] ?? "", ORPHAN_TEXT)).toBe(1);

      // Persisted history: chat.history serves the session, the accepted message stayed a
      // standalone visible row, and the new turn's durable row holds only the new text.
      const history = await gateway.client.request<{ messages?: Array<{ content?: unknown }> }>(
        "chat.history",
        { sessionKey, limit: 50 },
      );
      const messages = history.messages ?? [];
      const texts = messages.map(messageText);
      expect(texts.filter((text) => text.includes(ORPHAN_TEXT))).toEqual([ORPHAN_TEXT]);
      expect(texts).toContain(NEW_TEXT);
      expect(JSON.stringify(messages)).toContain(REPLY_MARKER);

      // No rewind happened: the transcript never gained a leaf control event, so the
      // projection kept appending instead of being marked for a full rebuild.
      const events = loadTranscriptEventsSync(target);
      expect(events).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "leaf" })]),
      );
    } finally {
      await fixture.close(gateway, providerServer);
    }
  },
);
