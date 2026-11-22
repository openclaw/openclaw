// Real-Gateway proof for session-scoped observer utility routing on multi-user
// Gateways: two interleaved dashboard sessions on one agent, each pinned to a
// different linked model account, run real turns and the Control UI session
// observer publishes every digest through the session owner's own credential.
// The Gateway server, agent runner, session store, auth profile store, session
// observer, utility completion, and credential selection are real; only the
// Anthropic Messages endpoint is a loopback fixture that records the exact
// x-api-key each request authenticated with.
//
// The agent-level auth order for anthropic is one deliberately unusable
// placeholder profile (the issue's setup), so a digest can only succeed through
// the session owner's linked account. Agent-level utility consumers outside
// this PR's scope (for example activity recaps) may still hit that placeholder
// and observe its 401.
import { createServer } from "node:http";
import { text as readText } from "node:stream/consumers";
import { expect, it, onTestFinished } from "vitest";
import type { AuthProfileStore } from "../src/agents/auth-profiles/types.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { listenLoopback } from "./helpers/gateway-integration-fixtures.js";

const TOKEN = "session-observer-linked-accounts-proof";
const CHAT_MODEL = "claude-opus-5-5";
const UTILITY_MODEL = "claude-haiku-5-5";
const PRIMARY_REF = `anthropic/${CHAT_MODEL}`;
const LINKED_KEYS = {
  alice: "sk-ant-linked-alice",
  bob: "sk-ant-linked-bob",
} as const;
const PLACEHOLDER_KEY = "sk-ant-invalid-placeholder";
const OWNER_SESSION_KEYS = {
  alice: "agent:main:session-alice",
  bob: "agent:main:session-bob",
} as const;

type ProviderRequest = {
  key: string;
  model: string;
  /** Observer digest calls are identified by the observer system prompt. */
  observerDigest: boolean;
  status: number;
};

type ObserverDigest = {
  sessionKey?: string;
  headline?: string;
  health?: string;
};

function ownerForLinkedKey(key: string): "alice" | "bob" | undefined {
  for (const [owner, linkedKey] of Object.entries(LINKED_KEYS)) {
    if (key === linkedKey) {
      return owner as "alice" | "bob";
    }
  }
  return undefined;
}

function digestText(owner: "alice" | "bob"): string {
  return JSON.stringify({
    headline: `Linked account ${owner} assessed this run`,
    assessment: `The session owned by ${owner} is progressing on its own linked account.`,
    health: "on-track",
    planProgress: { completed: 2, total: 3 },
  });
}

function anthropicSseEvents(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function anthropicTextTurn(model: string, text: string): string {
  return anthropicSseEvents([
    {
      type: "message_start",
      message: {
        id: "msg_proof",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 120, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 24 },
    },
    { type: "message_stop" },
  ]);
}

function anthropicToolUseTurn(model: string, callId: string): string {
  return anthropicSseEvents([
    {
      type: "message_start",
      message: {
        id: `msg_${callId}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 140, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: callId, name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":"/workspace/notes.txt"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 32 },
    },
    { type: "message_stop" },
  ]);
}

it(
  "publishes observer digests for interleaved linked sessions through each owner's credential",
  { timeout: 240_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "session-observer-linked-accounts",
      env: {
        OPENCLAW_GATEWAY_TOKEN: TOKEN,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        // The bundled anthropic plugin supplies the provider-declared default
        // utility model, keeping the auto-derivation path (utilityModel unset).
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });
    onTestFinished(async () => {
      await state.cleanup();
    });

    // The agent's auth order for anthropic is one deliberately unusable
    // placeholder profile, so only a session's linked account can serve calls.
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic-alice": { type: "api_key", provider: "anthropic", key: LINKED_KEYS.alice },
        "anthropic-bob": { type: "api_key", provider: "anthropic", key: LINKED_KEYS.bob },
        "anthropic-placeholder": {
          type: "api_key",
          provider: "anthropic",
          key: PLACEHOLDER_KEY,
        },
      },
      order: { anthropic: ["anthropic-placeholder"] },
    };
    await state.writeAuthProfiles(authStore, "main");

    const providerRequests: ProviderRequest[] = [];
    const chatRounds = new Map<string, number>();
    const server = createServer((request, response) => {
      void readText(request).then((raw) => {
        const body = JSON.parse(raw) as {
          model?: string;
          stream?: boolean;
          system?: unknown;
        };
        const key = String(request.headers["x-api-key"] ?? "");
        const model = body.model ?? "";
        const stream = body.stream === true;
        const systemText = JSON.stringify(body.system) ?? "";
        const observerDigest = systemText.includes("You judge the trajectory");
        const owner = ownerForLinkedKey(key);
        const respond = (status: number, contentType: string, payload: string) => {
          providerRequests.push({ key, model, observerDigest, status });
          response.writeHead(status, {
            "content-type": contentType,
            "cache-control": "no-cache",
          });
          response.end(payload);
        };
        if (!owner) {
          // Mirror the reported provider failure for the unusable placeholder.
          respond(
            401,
            "application/json",
            JSON.stringify({
              type: "error",
              error: { type: "authentication_error", message: "invalid x-api-key" },
            }),
          );
          return;
        }
        if (model === UTILITY_MODEL) {
          // Observer digests answer with a per-owner digest, so each published
          // digest names the account its provider request authenticated with.
          const text = digestText(owner);
          if (!stream) {
            respond(
              200,
              "application/json",
              JSON.stringify({
                id: "msg_observer_proof",
                type: "message",
                role: "assistant",
                model,
                content: [{ type: "text", text }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 96, output_tokens: 48 },
              }),
            );
            return;
          }
          respond(200, "text/event-stream", anthropicTextTurn(model, text));
          return;
        }
        const round = (chatRounds.get(key) ?? 0) + 1;
        chatRounds.set(key, round);
        if (round === 1) {
          // First turn drives a real tool call so the observer records activity.
          respond(200, "text/event-stream", anthropicToolUseTurn(model, `call_${owner}_1`));
          return;
        }
        respond(200, "text/event-stream", anthropicTextTurn(model, "Notes reviewed."));
      });
    });
    const origin = await listenLoopback(server);
    onTestFinished(async () => {
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    });

    const modelEntry = (id: string): ModelDefinitionConfig => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    });
    const provider: ModelProviderConfig = {
      baseUrl: `${origin}/v1`,
      api: "anthropic-messages",
      models: [modelEntry(CHAT_MODEL), modelEntry(UTILITY_MODEL)],
    };
    const cfg: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: TOKEN } },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: PRIMARY_REF },
        },
        entries: { main: {} },
      },
      models: { mode: "replace", providers: { anthropic: provider } },
      plugins: { allow: ["anthropic"] },
    };

    // Two pre-existing sessions, each pinned to its owner's linked account. The
    // session store writer requires a prepared runtime config.
    setRuntimeConfigSnapshot(cfg, cfg);
    for (const owner of ["alice", "bob"] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey: OWNER_SESSION_KEYS[owner] },
        {
          sessionId: `session-${owner}`,
          updatedAt: Date.now(),
          authProfileOverride: `anthropic-${owner}`,
        },
      );
    }

    const observerDigests: ObserverDigest[] = [];
    const gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token: TOKEN,
      clientDisplayName: "session-observer-proof",
      onEvent: (evt) => {
        if (evt.event === "session.observer") {
          observerDigests.push(evt.payload as ObserverDigest);
        }
      },
    });
    onTestFinished(async () => {
      await gateway.server.close().catch(() => undefined);
    });

    await gateway.client.request("sessions.observer.visibility", { visible: true });
    for (const owner of ["alice", "bob"] as const) {
      const subscribed = await gateway.client.request<{ subscribed?: boolean }>(
        "sessions.messages.subscribe",
        { key: OWNER_SESSION_KEYS[owner], agentId: "main" },
      );
      expect(subscribed).toMatchObject({ subscribed: true });
    }

    // Two interleaved turns: one real run per session on the agent.
    const runs = new Map<string, string>();
    for (const owner of ["alice", "bob"] as const) {
      const started = await gateway.client.request<{ status?: string; runId?: string }>(
        "chat.send",
        {
          sessionKey: OWNER_SESSION_KEYS[owner],
          message: "Read my notes and summarize what changed.",
          deliver: false,
          idempotencyKey: `observer-proof-${owner}`,
        },
      );
      expect(started).toMatchObject({ status: "started" });
      expect(typeof started.runId).toBe("string");
      runs.set(owner, started.runId!);
    }
    for (const [owner, runId] of runs) {
      const waited = await gateway.client.request<{ status?: string }>(
        "agent.wait",
        { runId, timeoutMs: 120_000 },
        { timeoutMs: 125_000 },
      );
      expect(waited, `agent.wait for ${owner}`).toMatchObject({ status: "ok" });
    }

    // Observer digests publish ~12s after each session's last activity.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const published = new Set(observerDigests.map((digest) => digest.sessionKey));
      if (["alice", "bob"].every((owner) => published.has(OWNER_SESSION_KEYS[owner as "alice"]))) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }

    // Each session's digest was published and names the account its own
    // provider request authenticated with.
    for (const owner of ["alice", "bob"] as const) {
      const digest = observerDigests.find(
        (candidate) => candidate.sessionKey === OWNER_SESSION_KEYS[owner],
      );
      expect(digest, `observer digest for ${owner}`).toBeDefined();
      expect(digest?.headline).toBe(`Linked account ${owner} assessed this run`);
      expect(digest?.health).toBe("on-track");
    }

    // Provider trace: every observer digest request authenticated with a linked
    // account key and succeeded; the unusable agent-level placeholder was never
    // used for a digest.
    const digestRequests = providerRequests.filter((entry) => entry.observerDigest);
    expect(digestRequests.length).toBeGreaterThanOrEqual(2);
    for (const entry of digestRequests) {
      expect(entry.status, `observer digest request for key ${entry.key}`).toBe(200);
      expect(entry.key).not.toBe(PLACEHOLDER_KEY);
    }
    const digestKeys = digestRequests.map((entry) => entry.key).toSorted();
    expect(digestKeys).toContain(LINKED_KEYS.alice);
    expect(digestKeys).toContain(LINKED_KEYS.bob);
    for (const key of digestKeys) {
      expect(ownerForLinkedKey(key)).toBeDefined();
    }

    // Each session's own turn ran on its owner's linked account as well.
    const chatKeys = providerRequests
      .filter((entry) => entry.model === CHAT_MODEL)
      .map((entry) => entry.key);
    expect(chatKeys).toContain(LINKED_KEYS.alice);
    expect(chatKeys).toContain(LINKED_KEYS.bob);
  },
);
