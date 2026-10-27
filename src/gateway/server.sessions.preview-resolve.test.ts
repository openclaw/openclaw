import { expect, onTestFinished, test, vi } from "vitest";
import { readSessionManagerBoundedSelection } from "../agents/sessions/session-manager-bounded-selection.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { GatewayClient } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";
import type { SessionsPreviewResult } from "./session-utils.types.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();
type ResolvedSession = {
  ok: boolean;
  key: string;
  candidates: Array<{ key: string; displayName?: string }>;
};
function resolveSession(params: Record<string, unknown>, client: GatewayClient) {
  return directSessionReq<ResolvedSession>("sessions.resolve", params, { client });
}
const expectResolved = (result: unknown, key: string) =>
  expect(result).toMatchObject({ ok: true, payload: { ok: true, key } });

function identifiedClient(profileId: string, scopes: string[] = ["operator.read"]): GatewayClient {
  return {
    connect: gatewayConnect(scopes),
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: gatewayProfile(profileId, profileId),
  };
}

test("sessions.preview widens past filtered tool rows within the requested text budget", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  await writeSessionStore({ entries: { "agent:main:main": sessionStoreEntry(sessionId) } });
  await sessionAccessor.persistSessionTranscriptTurn(
    { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath },
    {
      updateMode: "none",
      messages: [
        { role: "user", content: "Long preview input crosses the requested character budget." },
        { role: "assistant", content: "Hi" },
        { role: "assistant", content: [{ type: "toolcall", name: "weather" }] },
        ...Array.from({ length: 320 }, (_, index) => ({
          role: "toolResult",
          content: `tool ${index}`,
        })),
        { role: "assistant", content: "Forecast ready" },
      ].map((message) => ({ message })),
    },
  );

  const preview = await directSessionReq<SessionsPreviewResult>("sessions.preview", {
    keys: ["main"],
    limit: 3,
    maxChars: 24,
  });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry).toMatchObject({ key: "main", status: "ok" });
  expect(entry?.items).toEqual([
    { role: "user", text: "Long preview input cr..." },
    { role: "assistant", text: "Hi" },
    { role: "assistant", text: "Forecast ready" },
  ]);
});

test("sessions.resolve filters discovery selectors with sessions.list visibility", async () => {
  await createSessionStoreDir();
  const visibleKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
  const secondVisibleKey = "agent:main:thread:12345678-0ccc-4000-8000-000000000005";
  const hiddenCollisionKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
  const hiddenOnlyKey = "agent:main:thread:deadbeef-0aaa-4000-8000-000000000003";
  const incognitoKey = "agent:main:dashboard:incognito-cafebabe-0aaa-4000-8000-000000000004";
  const entry = (
    id: string,
    updatedAt: number,
    displayName: string,
    visibility: "shared" | "draft",
    label = id,
  ) => ({
    sessionId: `sess-${id}`,
    label,
    displayName,
    updatedAt,
    visibility,
    createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
  });
  await writeSessionStore({
    entries: {
      [visibleKey]: entry("collision", 40, "Visible session", "shared", "collision-label"),
      [hiddenCollisionKey]: entry("collision", 30, "Hidden collision", "draft", "collision-label"),
      [secondVisibleKey]: entry("second-visible", 35, "Second visible session", "shared"),
      [hiddenOnlyKey]: entry("hidden-only", 20, "Hidden only", "draft"),
    },
  });
  const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
  onTestFinished(() => {
    closeOpenClawAgentDatabaseByPath(incognitoPath);
  });
  await sessionAccessor.upsertSessionEntryCore(
    { agentId: "main", sessionKey: incognitoKey, storePath: incognitoPath },
    {
      sessionId: "sess-incognito",
      label: "incognito-only",
      displayName: "Incognito only",
      updatedAt: 10,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "viewer" },
      incognito: true,
    },
  );
  const client = identifiedClient("viewer");

  for (const params of [
    { shortId: "deadbeef" },
    { shortId: "cafebabe" },
    { sessionId: "sess-hidden-only" },
    { label: "hidden-only" },
  ]) {
    const hidden = await resolveSession(params, client);
    expect(hidden.ok).toBe(false);
    expect(hidden.error?.message).toContain("No session found");
  }

  const ambiguous = await resolveSession({ shortId: "12345678" }, client);
  expect(ambiguous).toMatchObject({
    ok: true,
    payload: {
      ok: false,
      candidates: [{ key: visibleKey }, { key: secondVisibleKey }],
    },
  });

  for (const params of [{ sessionId: "sess-collision" }, { label: "collision-label" }]) {
    expectResolved(await resolveSession(params, client), visibleKey);
  }

  expectResolved(await resolveSession({ key: hiddenOnlyKey }, client), hiddenOnlyKey);

  for (const key of [hiddenOnlyKey, "agent:main:hidden-only"]) {
    const reference = await resolveSession(
      { reference: { key, slug: "hidden-only" }, agentId: "main", allowMissing: true },
      client,
    );
    expect(reference).toMatchObject({ ok: true, payload: { ok: false } });
  }

  expectResolved(
    await resolveSession({ shortId: "deadbeef" }, identifiedClient("owner")),
    hiddenOnlyKey,
  );

  const admin = identifiedClient("admin", ["operator.admin"]);
  const adminIncognitoDiscovery = await resolveSession({ shortId: "cafebabe" }, admin);
  expect(adminIncognitoDiscovery.ok).toBe(false);
  expect(adminIncognitoDiscovery.error?.message).toContain("No session found");
  expectResolved(await resolveSession({ key: incognitoKey }, admin), incognitoKey);
});

test("sessions.resolve by key respects spawnedBy visibility filters", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const parents: Array<[string, number, string]> = [
    ["visible-parent", 3_000, "agent:main:main"],
    ["hidden-parent", 2_000, "agent:main:main"],
    ["shared-child-key-filter", 1_000, "agent:main:subagent:hidden-parent"],
  ];
  await writeSessionStore({
    entries: Object.fromEntries(
      parents.map(([id, age, spawnedBy]) => [
        `agent:main:subagent:${id}`,
        {
          sessionId: `sess-${id}`,
          updatedAt: now - age,
          spawnedBy,
        },
      ]),
    ),
  });

  const { ws } = await openClient();
  const resolved = await rpcReq(ws, "sessions.resolve", {
    key: "agent:main:subagent:shared-child-key-filter",
    spawnedBy: "agent:main:subagent:visible-parent",
  });

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.message).toContain(
    "No session found: agent:main:subagent:shared-child-key-filter",
  );
});

async function seedPreviewTail(
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { "agent:main:main": sessionStoreEntry(sessionId) },
  });
  const scope = { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath };
  await sessionAccessor.persistSessionTranscriptTurn(scope, {
    messages: messages.map((message) => ({ message })),
    touchSessionEntry: false,
  });
  return { ...scope, sessionEntry: { sessionId } };
}

test("session preview reader recovers visible rows behind a long hidden tail", async () => {
  const scope = await seedPreviewTail("sess-preview-deep-hidden-tail", [
    ...Array.from({ length: 64 }, (_, index) => ({
      role: "assistant",
      content: `visible ${String(index)}`,
    })),
    ...Array.from({ length: 1500 }, (_, index) => ({
      role: "toolResult",
      content: `tool ${String(index)}`,
    })),
  ]);
  const items = await readSessionPreviewItemsFromTranscriptAsync(scope, 12, 120);
  expect(items).toEqual(
    Array.from({ length: 12 }, (_, index) => ({
      role: "assistant",
      text: `visible ${String(52 + index)}`,
    })),
  );
});

test("session preview reader returns short visible history behind a long hidden tail", async () => {
  const scope = await seedPreviewTail("sess-preview-short-visible", [
    { role: "assistant", content: "only visible" },
    ...Array.from({ length: 1500 }, (_, index) => ({
      role: "toolResult",
      content: `tool ${String(index)}`,
    })),
  ]);
  const items = await readSessionPreviewItemsFromTranscriptAsync(scope, 12, 120);
  expect(items).toEqual([{ role: "assistant", text: "only visible" }]);
});

test("session preview owner stops at its explicit tail scan ceiling", async () => {
  const sessionId = "sess-preview-scan-ceiling";
  // The hidden tail exceeds the 2,048-event ceiling, so the visible rows stay unreachable.
  const scope = await seedPreviewTail(sessionId, [
    ...Array.from({ length: 64 }, (_, index) => ({
      role: "assistant",
      content: `visible ${String(index)}`,
    })),
    ...Array.from({ length: 2100 }, (_, index) => ({
      role: "toolResult",
      content: `tool ${String(index)}`,
    })),
  ]);
  const { path: databasePath } = resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath);
  const { readSessionPreviewItemsReadOnly } =
    await import("./session-transcript-preview-reader.js");
  const historyQuery = await import("../config/sessions/session-accessor.sqlite-history-query.js");
  const readPage = historyQuery.readRecentSessionTranscriptHistoryEventsFromProjection;
  const calls: Array<{ maxMessages: number; events: number }> = [];
  const spy = vi
    .spyOn(historyQuery, "readRecentSessionTranscriptHistoryEventsFromProjection")
    .mockImplementation((projection, options) => {
      const page = readPage(projection, options);
      calls.push({ maxMessages: options.maxMessages, events: page.events.length });
      return page;
    });
  try {
    const items = readSessionPreviewItemsReadOnly({
      kind: "session-preview",
      database: { agentId: "main", path: databasePath },
      target: { agentId: "main", sessionId, sessionKey: "agent:main:main" },
      maxItems: 12,
      maxChars: 120,
    });
    // No preview result field reports scan exhaustion yet; this residual gap is explicit.
    expect(items).toEqual([]);
    expect(calls.map((call) => call.maxMessages)).toEqual([64, 1024, 2048]);
    expect(calls.reduce((total, call) => total + call.events, 0)).toBeLessThanOrEqual(2048 * 2);
  } finally {
    spy.mockRestore();
  }
});

test("Talk model-context preview shares the bounded hidden-tail recovery", async () => {
  const scope = await seedPreviewTail("sess-preview-talk-hidden-tail", [
    ...Array.from({ length: 64 }, (_, index) => ({
      role: "assistant",
      content: `visible ${String(index)}`,
    })),
    ...Array.from({ length: 1500 }, (_, index) => ({
      role: "toolResult",
      content: `tool ${String(index)}`,
    })),
  ]);
  const items = await readSessionPreviewItemsFromTranscriptAsync(scope, 16, 800, "model-context");
  expect(items).toEqual(
    Array.from({ length: 16 }, (_, index) => ({
      role: "assistant",
      text: `visible ${String(48 + index)}`,
    })),
  );
});

test("Talk model-context stops when the byte budget caps the recovery page", async () => {
  const sessionId = "sess-preview-talk-byte-cap";
  // 1,023 tiny rows fit the 8 MiB recovery budget; the older 5 MiB row cannot.
  const scope = await seedPreviewTail(sessionId, [
    ...Array.from({ length: 64 }, (_, index) => ({
      role: "assistant",
      content: `visible ${String(index)}`,
    })),
    { role: "toolResult", content: "h".repeat(5 * 1024 * 1024) },
    ...Array.from({ length: 1023 }, (_, index) => ({
      role: "toolResult",
      content: `${String(index)}${"t".repeat(4096)}`,
    })),
  ]);
  const opens: (number | undefined)[] = [];
  const managers: SessionManager[] = [];
  const openBoundedAsync = SessionManager.openBoundedAsync.bind(SessionManager);
  const spy = vi
    .spyOn(SessionManager, "openBoundedAsync")
    .mockImplementation(async (target, options) => {
      const manager = await openBoundedAsync(target, options);
      opens.push("maxEvents" in options ? options.maxEvents : undefined);
      managers.push(manager);
      return manager;
    });
  try {
    const items = await readSessionPreviewItemsFromTranscriptAsync(scope, 12, 120, "model-context");
    // No visible rows are inside the byte budget; the bounded read must not repeat it.
    expect(items).toEqual([]);
    expect(opens).toEqual([64, 1024]);
    // The header is not a selected row: 1,023 is below the 1,024-event cap, so bytes stopped it.
    expect(readSessionManagerBoundedSelection(managers[1]!)).toEqual({
      selectedEvents: 1023,
      truncated: true,
    });
  } finally {
    spy.mockRestore();
  }
});
