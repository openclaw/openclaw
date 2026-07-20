// Context-engine transcript cursor E2E tests load a generic external plugin in
// a real Gateway process and exercise its public SDK reads against SQLite.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  replaceTranscriptEvents,
  upsertSessionEntry,
} from "../src/config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../src/config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptIndexReconcile } from "../src/config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "transcript-cursor-context-fixture";
const SNAPSHOT_METHOD = `${PLUGIN_ID}.snapshot`;
const SESSION_ID = "transcript-cursor-e2e";
const SESSION_KEY = `agent:main:${SESSION_ID}`;
const MODEL_REF = "cursor-e2e/cursor-e2e";
const SEED_MESSAGE_COUNT = 10_000;
const SDK_MAX_BYTES = 16 * 1024 * 1024;
const SDK_MAX_MESSAGES = 5_000;
const TEST_TIMEOUT_MS = 300_000;

type ModelServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type CursorSnapshot = {
  bootstrapCount: number;
  count: number;
  firstContent?: unknown;
  firstEntryId?: string;
  hasCursor: boolean;
  lastEntryId?: string;
  maxEntriesPerPage: number;
  maxSerializedBytes: number;
  pageCount: number;
  resetCount: number;
};

type CursorFixtureSnapshot = {
  factoryCount: number;
  lifecycle: { afterTurn: number; assemble: number; bootstrap: number };
  session: CursorSnapshot | null;
};

type HistoryMessage = {
  content?: string | Array<{ text?: string }>;
  __openclaw?: { id?: string; seq?: number };
};

type HistoryBody = {
  hasMore?: boolean;
  messages?: HistoryMessage[];
  nextCursor?: string;
};

type SseEvent = { data: unknown; event: string };

const instances: OpenClawTestInstance[] = [];
const modelServers: ModelServer[] = [];
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("external context-engine transcript cursor contract", () => {
  it(
    "pages a large transcript, resumes appends, and rebuilds after replacement",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cursor-e2e-"));
      cleanupDirs.push(fixtureRoot);
      const bundledRoot = path.join(fixtureRoot, "bundled");
      await writeContextEnginePlugin(bundledRoot);

      const modelServer = await startModelServer();
      modelServers.push(modelServer);
      const instance = await createOpenClawTestInstance({
        name: "context-engine-transcript-cursor",
        gatewayToken: "gateway-token",
        config: createTestConfig(modelServer.baseUrl),
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        },
      });
      instances.push(instance);

      const storePath = path.join(instance.state.sessionsDir("main"), "sessions.json");
      const target = {
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath,
      };
      await upsertSessionEntry(target, { sessionId: SESSION_ID, updatedAt: Date.now() });
      await replaceTranscriptEvents(target, createSeedEvents(SEED_MESSAGE_COUNT));

      await instance.startGateway();
      await waitForGatewayReady(instance);
      const client = await connectGatewayClient({
        url: instance.url,
        token: "gateway-token",
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        await runAgentTurn(client, instance, "append after bounded bootstrap");
        await waitForTranscriptProjection(target);
        const appendedFixture = await readCursorSnapshot(client);
        const appended = appendedFixture.session;
        expect(appendedFixture.factoryCount, instance.logs()).toBeGreaterThan(0);
        expect(appendedFixture.lifecycle.afterTurn).toBeGreaterThan(0);
        expect(appendedFixture.lifecycle.assemble).toBeGreaterThan(0);
        expect(appendedFixture.lifecycle.bootstrap).toBe(1);
        expect(appended, `${JSON.stringify(appendedFixture)}\n${instance.logs()}`).toMatchObject({
          bootstrapCount: 1,
          count: SEED_MESSAGE_COUNT + 2,
          firstContent: "seed message 1",
          firstEntryId: "seed-1",
          hasCursor: true,
        });
        if (!appended) {
          throw new Error("context engine did not create transcript cursor state");
        }
        expect(appended.pageCount).toBeGreaterThan(1);
        expect(appended.maxEntriesPerPage).toBeLessThanOrEqual(SDK_MAX_MESSAGES);
        expect(appended.maxSerializedBytes).toBeLessThanOrEqual(SDK_MAX_BYTES);

        const resetCountAfterAgentTurn = appended.resetCount;
        await appendTranscriptMessage(target, {
          message: { role: "user", content: "pure append cursor proof" },
        });
        await waitForTranscriptProjection(target);
        const pureAppend = (await readCursorSnapshot(client)).session;
        expect(pureAppend).toMatchObject({
          count: SEED_MESSAGE_COUNT + 3,
          firstContent: "seed message 1",
          firstEntryId: "seed-1",
          resetCount: resetCountAfterAgentTurn,
        });

        const firstPage = await fetchHistory(instance, "?limit=50");
        expect(firstPage.messages).toHaveLength(50);
        expect(firstPage.hasMore).toBe(true);
        expect(firstPage.nextCursor).toBeTruthy();
        expect(firstPage.nextCursor).not.toMatch(/^(?:seq:)?\d+$/u);
        const secondPage = await fetchHistory(
          instance,
          `?limit=50&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
        );
        expect(secondPage.messages).toHaveLength(50);
        const firstIds = new Set(firstPage.messages?.map((message) => message.__openclaw?.id));
        expect(secondPage.messages?.some((message) => firstIds.has(message.__openclaw?.id))).toBe(
          false,
        );

        const stream = await openHistoryStream(instance, "?limit=50");
        try {
          const initialHistory = await readSseEvent(stream.reader, stream.buffer);
          expect(initialHistory.event).toBe("history");
          expect((initialHistory.data as HistoryBody).messages).toHaveLength(50);

          await replaceTranscriptEvents(target, [
            {
              type: "message",
              id: "replacement-baseline",
              parentId: null,
              timestamp: "2026-07-19T00:00:00.000Z",
              message: { role: "assistant", content: "replacement baseline" },
            },
          ]);
          await runAgentTurn(client, instance, "append after destructive replacement");
          await waitForTranscriptProjection(target);

          const rebuiltFixture = await readCursorSnapshot(client);
          const rebuilt = rebuiltFixture.session;
          expect(rebuiltFixture.factoryCount, instance.logs()).toBeGreaterThan(0);
          expect(rebuilt, `${JSON.stringify(rebuiltFixture)}\n${instance.logs()}`).toMatchObject({
            count: 3,
            firstContent: "replacement baseline",
            hasCursor: true,
          });
          if (!rebuilt) {
            throw new Error("context engine did not rebuild transcript cursor state");
          }
          expect(rebuilt.resetCount).toBeGreaterThan(resetCountAfterAgentTurn);
          expect(rebuilt.maxEntriesPerPage).toBeLessThanOrEqual(SDK_MAX_MESSAGES);
          expect(rebuilt.maxSerializedBytes).toBeLessThanOrEqual(SDK_MAX_BYTES);

          const replacementHistory = await readUntilHistoryContains(
            stream.reader,
            stream.buffer,
            "replacement baseline",
          );
          expect(replacementHistory.messages?.length).toBeGreaterThanOrEqual(2);
          const finalHistory = await fetchHistory(instance, "?limit=50");
          expect(finalHistory.messages?.map(readMessageText)).toEqual([
            "replacement baseline",
            "append after destructive replacement",
            "cursor e2e response 2",
          ]);
        } finally {
          await stream.reader.cancel();
        }
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

function createTestConfig(baseUrl: string): OpenClawConfig {
  return {
    plugins: {
      enabled: true,
      allow: [PLUGIN_ID],
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { contextEngine: PLUGIN_ID, memory: "none" },
    },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        "cursor-e2e": {
          baseUrl: `${baseUrl}/v1`,
          apiKey: "fixture-api-key",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "cursor-e2e",
              name: "cursor-e2e",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 10_000_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

async function waitForTranscriptProjection(
  target: Parameters<typeof resolveSqliteTranscriptReadScope>[0],
): Promise<void> {
  await waitForSessionTranscriptIndexReconcile(
    toDatabaseOptions(resolveSqliteTranscriptReadScope(target)),
  );
}

function createSeedEvents(count: number): Parameters<typeof replaceTranscriptEvents>[1] {
  return [
    {
      type: "session",
      id: SESSION_ID,
      version: 3,
      timestamp: "2026-07-18T00:00:00.000Z",
    },
    ...Array.from({ length: count }, (_, index) => {
      const messageNumber = index + 1;
      return {
        type: "message",
        id: `seed-${messageNumber}`,
        parentId: index === 0 ? null : `seed-${index}`,
        timestamp: "2026-07-18T00:00:00.000Z",
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `seed message ${messageNumber}`,
        },
      };
    }),
  ];
}

async function waitForGatewayReady(instance: OpenClawTestInstance): Promise<void> {
  const readyMarker = "[gateway] startup outcomes:";
  if (instance.logs().includes(readyMarker)) {
    return;
  }
  const child = instance.child;
  if (!child) {
    throw new Error("gateway process was not started");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error(`timed out waiting for gateway readiness\n${instance.logs()}`)),
      60_000,
    );
    const onData = () => {
      if (instance.logs().includes(readyMarker)) {
        finish();
      }
    };
    const onExit = () => finish(new Error(`gateway exited before readiness\n${instance.logs()}`));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    onData();
  });
}

async function runAgentTurn(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  instance: OpenClawTestInstance,
  message: string,
): Promise<void> {
  const runId = randomUUID();
  const started = await client.request<{ runId?: string; status?: string }>("agent", {
    sessionKey: SESSION_KEY,
    message,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(started.status).toBe("accepted");
  const completed = await client.request<{ error?: unknown; status?: string }>(
    "agent.wait",
    { runId: started.runId ?? runId, timeoutMs: 180_000 },
    { timeoutMs: 185_000 },
  );
  expect(completed.status, `${JSON.stringify(completed)}\n${instance.logs()}`).toBe("ok");
}

async function readCursorSnapshot(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
): Promise<CursorFixtureSnapshot> {
  return await client.request<CursorFixtureSnapshot>(SNAPSHOT_METHOD, { sessionKey: SESSION_KEY });
}

async function fetchHistory(instance: OpenClawTestInstance, query: string): Promise<HistoryBody> {
  const response = await fetch(
    `http://127.0.0.1:${instance.port}/sessions/${encodeURIComponent(SESSION_KEY)}/history${query}`,
    { headers: historyHeaders(instance) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as HistoryBody;
}

function historyHeaders(instance: OpenClawTestInstance, accept?: string): HeadersInit {
  return {
    Authorization: `Bearer ${instance.gatewayToken}`,
    "x-openclaw-scopes": "operator.read",
    ...(accept ? { Accept: accept } : {}),
  };
}

async function openHistoryStream(
  instance: OpenClawTestInstance,
  query: string,
): Promise<{
  buffer: { value: string };
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const response = await fetch(
    `http://127.0.0.1:${instance.port}/sessions/${encodeURIComponent(SESSION_KEY)}/history${query}`,
    { headers: historyHeaders(instance, "text/event-stream") },
  );
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("expected session history SSE response body");
  }
  return { reader, buffer: { value: "" } };
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { value: string },
): Promise<SseEvent> {
  const decoder = new TextDecoder();
  for (;;) {
    const boundary = buffer.value.indexOf("\n\n");
    if (boundary >= 0) {
      const rawEvent = buffer.value.slice(0, boundary);
      buffer.value = buffer.value.slice(boundary + 2);
      const lines = rawEvent.split("\n");
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!data) {
        continue;
      }
      return {
        event:
          lines
            .find((line) => line.startsWith("event:"))
            ?.slice("event:".length)
            .trim() ?? "message",
        data: JSON.parse(data),
      };
    }
    const chunk = await readSseChunk(reader);
    if (chunk.done) {
      throw new Error("SSE stream ended before the expected history event");
    }
    buffer.value += decoder.decode(chunk.value, { stream: true });
  }
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out waiting for SSE history event")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readUntilHistoryContains(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { value: string },
  expectedText: string,
): Promise<HistoryBody> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const event = await readSseEvent(reader, buffer);
    if (event.event !== "history") {
      continue;
    }
    const history = event.data as HistoryBody;
    if (history.messages?.some((message) => readMessageText(message) === expectedText)) {
      return history;
    }
  }
  throw new Error(`SSE history did not include ${expectedText}`);
}

function readMessageText(message: HistoryMessage): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content?.map((part) => part.text ?? "").join("");
}

async function startModelServer(): Promise<ModelServer> {
  let responseCount = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "cursor-e2e", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      await readRequestBody(request);
      responseCount += 1;
      writeModelResponse(response, responseCount);
    })().catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("cursor E2E model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeModelResponse(response: ServerResponse, sequence: number): void {
  const text = `cursor e2e response ${sequence}`;
  const message = {
    type: "message",
    id: `cursor-e2e-message-${sequence}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `cursor-e2e-response-${sequence}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function writeContextEnginePlugin(bundledRoot: string): Promise<void> {
  const pluginDir = path.join(bundledRoot, PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(path.join(pluginDir, "node_modules"), { recursive: true });
  // A normally installed plugin resolves OpenClaw through its peer dependency.
  // The fixture symlink recreates that package-manager layout without installing.
  await fs.symlink(process.cwd(), path.join(pluginDir, "node_modules", "openclaw"), "dir");
  await Promise.all([
    fs.writeFile(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify({ type: "module", peerDependencies: { openclaw: "*" } }, null, 2)}\n`,
    ),
    fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id: PLUGIN_ID,
          kind: "context-engine",
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      )}\n`,
    ),
    fs.copyFile(
      new URL("./fixtures/context-engine-transcript-cursor-plugin.mjs", import.meta.url),
      path.join(pluginDir, "index.js"),
    ),
  ]);
}
