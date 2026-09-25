import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../shared/transcript-only-openclaw-assistant.js";
import * as profileAuthority from "../state/user-channel-identity-operations.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayHttpServer } from "./server-http.js";
import { readSseEvent } from "./session-history-fixtures.test-support.js";
import * as historyState from "./session-history-state.js";

const readerEmail = "history-reader@example.test";
const staffEmail = "history-staff@example.test";
const secret = "history-fixture-shared-secret";
const hiddenText = "example/historical remains ordinary message text";

function record(value: unknown) {
  return expectDefined(asOptionalRecord(value), "history record");
}

function messages(value: unknown, count: number) {
  const body = record(value);
  const rows = expectDefined(Array.isArray(body.messages) ? body.messages : undefined, "messages");
  expect(rows).toHaveLength(count);
  expect(body.items).toEqual(rows);
  return rows.map(record);
}

function expectHidden(message: unknown) {
  expect(message).not.toHaveProperty("provider");
  expect(message).not.toHaveProperty("model");
}

function config(allow = ["example/allowed"]): OpenClawConfig {
  return {
    agents: { entries: { main: {} }, defaults: { model: "example/allowed" } },
    plugins: { enabled: false },
    gateway: {
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
      },
      roles: {
        default: "reader",
        definitions: {
          reader: {
            agents: ["main"],
            scopes: ["operator.read"],
            sessions: { others: "view" },
            modelPolicy: { sourceAgent: "main", allow },
          },
          staff: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
        },
      },
    },
  };
}

describe("HTTP historical model disclosure", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: ReturnType<typeof createGatewayHttpServer>;
  let current: OpenClawConfig;
  let committed: OpenClawConfig;
  let port: number;
  let readerId: string;
  let sequence = 0;
  let scope: { agentId: string; sessionKey: string; sessionId: string };
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();

  const publishConfig = (next: OpenClawConfig, commit = true) => {
    current = next;
    if (commit) {
      committed = next;
    }
    setRuntimeConfigSnapshot(next);
  };

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal", label: "http-model-policy" });
    publishConfig(config());
    readerId = (await ensureCanonicalUserProfileForEmail(readerEmail)).id;
    const staff = await ensureCanonicalUserProfileForEmail(staffEmail);
    await setCanonicalUserProfileRole(staff.id, "staff");
    const context = createDirectChatContext({
      getRuntimeConfig: () => current,
      getCommittedRuntimeConfig: () => committed,
    });
    server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      handleHooksRequest: async () => false,
      resolvedAuth: resolveGatewayAuth({ authConfig: current.gateway?.auth }),
      getResolvedAuth: () => resolveGatewayAuth({ authConfig: current.gateway?.auth }),
      getRuntimeConfig: () => current,
      getGatewayRequestContext: () => context,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP fixture listener");
    }
    port = address.port;
  });

  beforeEach(async () => {
    publishConfig(config());
    const sessionId = `http-model-policy-${++sequence}`;
    scope = { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}` };
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: sequence,
      createdActor: { type: "human", source: "profile", id: readerId },
      visibility: "shared",
    });
    for (const [id, provider, model, content] of [
      ["hidden", "example", "historical", hiddenText],
      ["allowed", "example", "allowed", "allowed model reply"],
      ["bookkeeping", "openclaw", "delivery-mirror", "delivery bookkeeping reply"],
      ["cleared", null, null, "cleared model metadata reply"],
    ] as const) {
      await appendTranscriptMessage(scope, {
        eventId: `${sessionId}-${id}`,
        message: {
          role: "assistant",
          provider,
          model,
          content,
          stopReason: "stop",
          ...(id === "bookkeeping" ? { api: OPENCLAW_TRANSCRIPT_ARTIFACT_API } : {}),
        },
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...readers].map(async (reader) => await reader.cancel()));
    readers.clear();
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await state?.cleanup();
  });

  async function requestHistory(
    params: { sse?: boolean; email?: string; query?: string; owner?: boolean } = {},
  ) {
    const headers: Record<string, string> = params.owner
      ? { authorization: `Bearer ${secret}` }
      : {
          "x-forwarded-for": "192.0.2.10",
          "x-forwarded-proto": "https",
          "x-forwarded-user": params.email ?? readerEmail,
          "x-openclaw-scopes": "operator.read",
        };
    if (params.sse) {
      headers.accept = "text/event-stream";
    }
    const response = await fetch(
      `http://127.0.0.1:${port}/sessions/${encodeURIComponent(scope.sessionKey)}/history${params.query ?? ""}`,
      { headers },
    );
    expect(response.status).toBe(200);
    return response;
  }

  async function openStream(params: Parameters<typeof requestHistory>[0] = {}) {
    const response = await requestHistory({ ...params, sse: true });
    const reader = expectDefined(response.body?.getReader(), "SSE reader");
    readers.add(reader);
    const buffer = { buffer: "" };
    return { reader, next: () => readSseEvent(reader, buffer) };
  }

  function expectRestrictedSnapshot(value: unknown, count: number) {
    const rows = messages(value, count);
    expect(rows[0]).toMatchObject({ content: hiddenText });
    expectHidden(rows[0]);
    expect(rows[1]).toMatchObject({ provider: "example", model: "allowed" });
    expect(rows[2]).toMatchObject({ provider: "openclaw", model: "delivery-mirror" });
    expect(rows[3]).toMatchObject({ provider: null, model: null });
    return rows;
  }

  async function append(text: string, updateMode: "inline" | "file-only" = "inline") {
    const result = await appendExactAssistantMessageToSessionTranscript({
      ...scope,
      updateMode,
      message: makeAgentAssistantMessage({
        provider: "example",
        model: "historical",
        content: [{ type: "text", text }],
      }),
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.messageId;
  }

  it("filters identified JSON and all SSE publications without changing stored rows", async () => {
    const saved = await loadTranscriptEvents(scope);
    const json = await requestHistory().then((response) => response.json());
    const rows = expectRestrictedSnapshot(json, 4);
    const stream = await openStream();
    const initial = await stream.next();
    expect(initial.event).toBe("history");
    expect(initial.data).toEqual(json);

    const id = await append("inline private model reply");
    const inline = await stream.next();
    expect(inline.event).toBe("message");
    expect(inline.data).toMatchObject({
      messageId: id,
      messageSeq: 5,
      message: { __openclaw: { id, seq: 5 } },
    });
    expectHidden(record(inline.data).message);
    expect(record(inline.data).message).toMatchObject({
      content: [{ type: "text", text: "inline private model reply" }],
    });
    await append("refresh private model reply", "file-only");
    const refreshed = await stream.next();
    expect(refreshed.event).toBe("history");
    const refreshedRows = expectRestrictedSnapshot(refreshed.data, 6);
    expect(refreshedRows.slice(0, 4)).toEqual(rows);
    expectHidden(refreshedRows[4]);
    expectHidden(refreshedRows[5]);

    const persisted = await loadTranscriptEvents(scope);
    expect(persisted.slice(0, saved.length)).toEqual(saved);
    const staff = await requestHistory({ email: staffEmail }).then((response) => response.json());
    const staffRows = messages(staff, 6);
    expect(staffRows[0]).toMatchObject({
      provider: "example",
      model: "historical",
      content: hiddenText,
    });
    expect(staffRows[4]).toMatchObject({ provider: "example", model: "historical" });
    expect(await loadTranscriptEvents(scope)).toEqual(persisted);
    const page = await requestHistory({ query: "?limit=2&cursor=5" }).then((response) =>
      response.json(),
    );
    expect(messages(page, 2)).toEqual(rows.slice(2));
    expect(page).toMatchObject({ hasMore: true, nextCursor: "3" });
  });

  it.each(["JSON", "initial SSE", "refresh SSE"] as const)(
    "uses committed narrowing after a held %s read",
    async (kind) => {
      publishConfig(config(["example/*"]));
      const fromSnapshot = vi.spyOn(historyState.SessionHistorySseState, "fromSnapshot");
      const stream = kind === "refresh SSE" ? await openStream() : undefined;
      if (stream) {
        expect(messages((await stream.next()).data, 4)[0]).toHaveProperty("model", "historical");
      }
      const entered = createDeferred();
      const release = createDeferred();
      const hold = async <T>(read: Promise<T>) => {
        const value = await read;
        entered.resolve();
        await release.promise;
        return value;
      };
      if (stream) {
        expect(fromSnapshot).toHaveBeenCalledTimes(1);
        const streamState = expectDefined(
          fromSnapshot.mock.results.find((result) => result.type === "return")?.value,
          "SSE history state",
        );
        const refresh = streamState.refreshAsync.bind(streamState);
        vi.spyOn(streamState, "refreshAsync").mockImplementationOnce(() => hold(refresh()));
      } else {
        const original = historyState.readSessionHistorySnapshotAsync;
        vi.spyOn(historyState, "readSessionHistorySnapshotAsync").mockImplementationOnce((params) =>
          hold(original(params)),
        );
      }
      const pending = stream
        ? append("held refresh reply", "file-only").then(async () => (await stream.next()).data)
        : kind === "JSON"
          ? requestHistory().then((response) => response.json())
          : openStream().then(async (opened) => (await opened.next()).data);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("History did not reach held read");
          }),
        ]);
        publishConfig(config());
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
      }
      const payload = await pending;
      expectRestrictedSnapshot(payload, stream ? 5 : 4);
      if (stream) {
        expectHidden(messages(payload, 5)[4]);
      }
    },
  );

  it("filters a refresh forced by a repeated committed inline sequence", async () => {
    const stream = await openStream();
    expectRestrictedSnapshot((await stream.next()).data, 4);
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    let id: string;
    try {
      id = await append("repeated inline sequence");
    } finally {
      unsubscribe();
    }
    expect((await stream.next()).event).toBe("message");
    const update = expectDefined(
      updates.find((candidate) => candidate.messageId === id),
      "committed inline update",
    );
    const stored = await loadTranscriptEvents(scope);
    emitSessionTranscriptUpdate(update);
    const refreshed = await stream.next();
    expect(refreshed.event).toBe("history");
    const rows = expectRestrictedSnapshot(refreshed.data, 5);
    expectHidden(rows[4]);
    expect(rows[4]).toMatchObject({
      content: [{ type: "text", text: "repeated inline sequence" }],
    });
    expect(await loadTranscriptEvents(scope)).toEqual(stored);
  });

  it("uses a policy committed during final current-profile acquisition", async () => {
    publishConfig(config(["example/*"]));
    const stream = await openStream();
    expect(messages((await stream.next()).data, 4)[0]).toHaveProperty("model", "historical");
    publishConfig(config(), false);
    const entered = createDeferred();
    const release = createDeferred();
    const original = profileAuthority.prepareUserProfileRoleAuthority;
    vi.spyOn(profileAuthority, "prepareUserProfileRoleAuthority").mockImplementationOnce(
      async (...args) => {
        const profile = await original(...args);
        entered.resolve();
        await release.promise;
        return profile;
      },
    );
    const appended = append("publication after committed narrowing");
    try {
      await entered.promise;
      committed = current;
    } finally {
      release.resolve();
      await appended;
    }
    const inline = await stream.next();
    expect(inline.event).toBe("message");
    expectHidden(record(inline.data).message);
    expect(record(inline.data).message).toMatchObject({
      content: [{ type: "text", text: "publication after committed narrowing" }],
    });
    const rows = expectRestrictedSnapshot(
      await requestHistory().then((response) => response.json()),
      5,
    );
    expectHidden(rows[4]);
  });

  it("keeps committed restriction during tentative widening, then publishes committed widening", async () => {
    const stream = await openStream();
    expectRestrictedSnapshot((await stream.next()).data, 4);
    publishConfig(config(["example/*"]), false);
    expectRestrictedSnapshot(await requestHistory().then((response) => response.json()), 4);
    await append("tentative widening inline");
    const hidden = await stream.next();
    expect(hidden.event).toBe("message");
    expectHidden(record(hidden.data).message);
    committed = current;
    await append("committed widening inline");
    const visible = await stream.next();
    expect(visible.event).toBe("message");
    expect(record(visible.data).message).toMatchObject({
      provider: "example",
      model: "historical",
    });
  });

  it.each(["token", "password"] as const)(
    "preserves intentionally broad %s owner history",
    async (mode) => {
      const next = config();
      next.gateway = { ...next.gateway, auth: { mode, [mode]: secret } };
      publishConfig(next);
      const response = await requestHistory({ owner: true });
      expect(messages(await response.json(), 4)[0]).toMatchObject({
        provider: "example",
        model: "historical",
      });
      const stream = await openStream({ owner: true });
      expect(messages((await stream.next()).data, 4)[0]).toHaveProperty("model", "historical");
    },
  );
});
