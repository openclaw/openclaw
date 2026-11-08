import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createRequireRecord } from "../../test/helpers/record.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OPENCLAW_TRANSCRIPT_ARTIFACT_API } from "../shared/transcript-only-openclaw-assistant.js";
import * as profileAuthority from "../state/user-channel-identity-operations.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayHttpServer } from "./server-http.js";
import * as historyState from "./session-history-state.js";
import { appendHistoryMessage, historyStream } from "./sessions-history-http-read.test-support.js";

const readerEmail = "history-reader@example.test";
const staffEmail = "history-staff@example.test";
const secret = "history-fixture-shared-secret";
const hiddenText = "example/historical remains ordinary message text";
const historical = { provider: "example", model: "historical" };

const record = createRequireRecord("record", "expected-record");

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

function expectPrivateText(message: unknown, text: string) {
  expectHidden(message);
  expect(message).toMatchObject({ content: [{ type: "text", text }] });
}

function heldRead() {
  const entered = createDeferred();
  const release = createDeferred();
  const hold = async <T>(read: Promise<T>) => {
    const value = await read;
    entered.resolve();
    await release.promise;
    return value;
  };
  return { entered, release, hold };
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
  let url: string;
  let readerId: string;
  let releaseProfileCatalog: (() => void) | undefined;
  let sequence = 0;
  let scope: { agentId: string; sessionKey: string; sessionId: string };

  const publishConfig = (next: OpenClawConfig, commit = true) => {
    current = next;
    if (commit) {
      committed = next;
    }
    setRuntimeConfigSnapshot(next);
  };

  beforeAll(async () => {
    state = await createOpenClawTestState({
      scenario: "minimal",
      label: "http-model-policy",
      prepareProfileCatalog: true,
    });
    publishConfig(config());
    readerId = (await ensureCanonicalUserProfileForEmail(readerEmail)).id;
    const staff = await ensureCanonicalUserProfileForEmail(staffEmail);
    await setCanonicalUserProfileRole(staff.id, "staff");
    releaseProfileCatalog = (await prepareUserProfileCatalog()).release;
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
      httpRequestLifetime: context,
    });
    url = await listenLoopback(server);
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
    for (const [index, metadata] of [
      { ...historical, content: hiddenText },
      { provider: "example", model: "allowed" },
      { provider: "openclaw", model: "delivery-mirror", api: OPENCLAW_TRANSCRIPT_ARTIFACT_API },
      { provider: null, model: null },
    ].entries()) {
      await appendTranscriptMessage(scope, {
        eventId: `${sessionId}-${index}`,
        message: { role: "assistant", content: "reply", stopReason: "stop", ...metadata },
      });
    }
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    try {
      if (server) {
        await closeHttpServer(server);
      }
    } finally {
      releaseProfileCatalog?.();
      await state?.cleanup();
    }
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
      `${url}/sessions/${encodeURIComponent(scope.sessionKey)}/history${params.query ?? ""}`,
      { headers },
    );
    expect(response.status).toBe(200);
    return response;
  }

  async function openStream(params: Parameters<typeof requestHistory>[0] = {}) {
    return historyStream(await requestHistory({ ...params, sse: true }));
  }

  const jsonHistory = (params?: Parameters<typeof requestHistory>[0]) =>
    requestHistory(params).then((response) => response.json());

  function expectRestrictedSnapshot(value: unknown, count: number) {
    const rows = messages(value, count);
    expect(rows[0]).toMatchObject({ content: hiddenText });
    expectHidden(rows[0]);
    expect(rows.slice(1, 4)).toMatchObject([
      { provider: "example", model: "allowed" },
      { provider: "openclaw", model: "delivery-mirror" },
      { provider: null, model: null },
    ]);
    rows.slice(4).forEach(expectHidden);
    return rows;
  }

  async function append(text: string, updateMode: "inline" | "file-only" = "inline") {
    const result = await appendHistoryMessage({
      ...scope,
      updateMode,
      message: makeAgentAssistantMessage({
        ...historical,
        content: [{ type: "text", text }],
      }),
    });
    return result.messageId;
  }

  it("filters identified JSON and all SSE publications without changing stored rows", async () => {
    const saved = await loadTranscriptEvents(scope);
    const json = await jsonHistory();
    const rows = expectRestrictedSnapshot(json, 4);
    await using stream = await openStream();
    expect(await stream.next()).toEqual(json);

    const id = await append("inline private model reply");
    const inline = await stream.next("message");
    expect(inline).toMatchObject({
      messageId: id,
      messageSeq: 5,
      message: { __openclaw: { id, seq: 5 } },
    });
    expectPrivateText(record(inline).message, "inline private model reply");
    await append("refresh private model reply", "file-only");
    const refreshedRows = expectRestrictedSnapshot(await stream.next(), 6);
    expect(refreshedRows.slice(0, 4)).toEqual(rows);
    expectPrivateText(refreshedRows[4], "inline private model reply");

    const persisted = await loadTranscriptEvents(scope);
    expect(persisted.slice(0, saved.length)).toEqual(saved);
    const staffRows = messages(await jsonHistory({ email: staffEmail }), 6);
    expect(staffRows[0]).toMatchObject({ ...historical, content: hiddenText });
    expect(staffRows[4]).toMatchObject(historical);
    expect(await loadTranscriptEvents(scope)).toEqual(persisted);
    const page = await jsonHistory({ query: "?limit=2&cursor=5" });
    expect(messages(page, 2)).toEqual(rows.slice(2));
    expect(page).toMatchObject({ hasMore: true, nextCursor: "3" });
  });

  it.each(["JSON", "initial SSE", "refresh SSE"] as const)(
    "uses committed narrowing after a held %s read",
    async (kind) => {
      publishConfig(config(["example/*"]));
      const fromSnapshot = vi.spyOn(historyState.SessionHistorySseState, "fromSnapshot");
      await using stream = kind === "refresh SSE" ? await openStream() : undefined;
      if (stream) {
        expect(messages(await stream.next(), 4)[0]).toHaveProperty("model", "historical");
      }
      const { entered, release, hold } = heldRead();
      if (stream) {
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
        ? append("held refresh reply", "file-only").then(() => stream.next())
        : kind === "JSON"
          ? jsonHistory()
          : (async () => {
              await using opened = await openStream();
              return await opened.next();
            })();
      try {
        await awaitGateBeforeSettlement(entered.promise, pending, "History read not held");
        publishConfig(config());
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
      }
      const payload = await pending;
      expectRestrictedSnapshot(payload, stream ? 5 : 4);
    },
  );

  it("uses a policy committed during final current-profile acquisition", async () => {
    publishConfig(config(["example/*"]));
    await using stream = await openStream();
    expect(messages(await stream.next(), 4)[0]).toHaveProperty("model", "historical");
    publishConfig(config(), false);
    const { entered, release, hold } = heldRead();
    const original = profileAuthority.prepareUserProfileRoleAuthority;
    vi.spyOn(profileAuthority, "prepareUserProfileRoleAuthority").mockImplementationOnce(
      (...args) => hold(original(...args)),
    );
    const appended = append("publication after committed narrowing");
    try {
      await entered.promise;
      committed = current;
    } finally {
      release.resolve();
      await appended;
    }
    expectPrivateText(
      record(await stream.next("message")).message,
      "publication after committed narrowing",
    );
    expectRestrictedSnapshot(await jsonHistory(), 5);
  });

  it("keeps committed restriction during tentative widening, then publishes committed widening", async () => {
    await using stream = await openStream();
    expectRestrictedSnapshot(await stream.next(), 4);
    publishConfig(config(["example/*"]), false);
    expectRestrictedSnapshot(await jsonHistory(), 4);
    await append("tentative widening inline");
    expectHidden(record(await stream.next("message")).message);
    committed = current;
    await append("committed widening inline");
    expect(record(await stream.next("message")).message).toMatchObject(historical);
  });

  it("preserves intentionally broad shared-secret owner history", async () => {
    const next = config();
    next.gateway = { ...next.gateway, auth: { mode: "token", token: secret } };
    publishConfig(next);
    expect(messages(await jsonHistory({ owner: true }), 4)[0]).toMatchObject(historical);
    await using stream = await openStream({ owner: true });
    expect(messages(await stream.next(), 4)[0]).toHaveProperty("model", "historical");
    const text = "bearer sse update";
    const id = await append(text);
    expect(await stream.next("message")).toMatchObject({
      messageSeq: 5,
      message: { ...historical, content: [{ text }], __openclaw: { id, seq: 5 } },
    });
  });
});
