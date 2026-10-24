import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { ControlUiSessionPreview } from "./control-ui-contract.js";
import type { GatewayClient } from "./server-methods/types.js";
import * as sessionRows from "./session-row-projection-record.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";
import type { SessionsListResult, SessionsPreviewResult } from "./session-utils.types.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  getGatewayConfigModule,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();
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

test("lists and previews the selected aggregate global owner over WebSocket", async () => {
  const config = await getGatewayConfigModule();
  const runtime = config.getRuntimeConfigSnapshot();
  const source = config.getRuntimeConfigSourceSnapshot();
  const previous = {
    agentsConfig: testState.agentsConfig,
    sessionConfig: testState.sessionConfig,
    sessionStorePath: testState.sessionStorePath,
  };
  const configPaths = new Set([
    config.CONFIG_PATH,
    ...(process.env.OPENCLAW_CONFIG_PATH ? [process.env.OPENCLAW_CONFIG_PATH] : []),
    ...(process.env.OPENCLAW_STATE_DIR
      ? [path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json")]
      : []),
  ]);
  const files = new Map<string, Buffer | undefined>();
  for (const configPath of configPaths) {
    try {
      files.set(configPath, await fs.readFile(configPath));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      files.set(configPath, undefined);
    }
  }
  onTestFinished(async () => {
    Object.assign(testState, previous);
    // The connected fixture publishes both config paths as well as its runtime snapshot.
    for (const [configPath, contents] of files) {
      if (contents === undefined) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, contents);
      }
    }
    if (runtime) {
      config.setRuntimeConfigSnapshot(runtime, source ?? undefined);
    } else {
      config.clearRuntimeConfigSnapshot();
    }
  });
  const { workStorePath } = await createSelectedGlobalSessionStore();
  testState.agentsConfig = {
    entries: {
      main: { model: { primary: "openai/gpt-5.4" } },
      work: { model: { primary: "openai/gpt-5.5" } },
    },
  };
  const sessionId = "aggregate-work-global";
  const workSqlitePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(workStorePath).path;
  const backfilled = Promise.withResolvers<void>();
  const publishTranscriptFields = sessionRows.publishTranscriptFields;
  const publication = vi
    .spyOn(sessionRows, "publishTranscriptFields")
    .mockImplementation((row, ...args) => {
      const changed = publishTranscriptFields(row, ...args);
      if (
        row.key === "global" &&
        row.agentId === "work" &&
        row.storeTarget.storePath === workSqlitePath &&
        row.entry.sessionId === sessionId &&
        row.lastMessagePreview === "Work global conversation"
      ) {
        backfilled.resolve();
      }
      return changed;
    });
  onTestFinished(() => publication.mockRestore());
  await writeSessionStore({
    agentId: "work",
    storePath: workStorePath,
    entries: { global: sessionStoreEntry(sessionId, { label: "Work global conversation" }) },
  });
  // The suite Gateway is already running, so publish the transcript to its projection.
  await sessionAccessor.persistSessionTranscriptTurn(
    { agentId: "work", sessionId, sessionKey: "global", storePath: workStorePath },
    {
      updateMode: "file-only",
      messages: [{ message: { role: "user", content: "Work global conversation" } }],
    },
  );
  const { ws } = await openClient();
  try {
    // Transcript enrichment starts only when a reader requests the selected row.
    const demand = await rpcReq<SessionsListResult>(ws, "sessions.list", {
      includeGlobal: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    expect(demand.ok).toBe(true);
    await backfilled.promise;
    for (const search of [undefined, "gpt-5.5"]) {
      const listed = await rpcReq<SessionsListResult>(ws, "sessions.list", {
        includeGlobal: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
        ...(search ? { search } : {}),
      });
      expect(listed.ok).toBe(true);
      expect(listed.payload?.sessions).toMatchObject([
        {
          key: "global",
          sessionId,
          agentId: "work",
          model: "gpt-5.5",
          derivedTitle: "Work global conversation",
        },
      ]);
    }
    const preview = await rpcReq<ControlUiSessionPreview>(ws, "controlUi.sessionPreview", {
      sessionKey: "agent:work:main",
    });
    expect(preview, JSON.stringify(preview)).toMatchObject({
      ok: true,
      payload: {
        status: "ok",
        agentId: "work",
        derivedTitle: "Work global conversation",
        lastMessagePreview: "Work global conversation",
      },
    });
    const resolved = await rpcReq(ws, "sessions.resolve", {
      label: "Work global conversation",
      includeGlobal: true,
    });
    expect(resolved).toMatchObject({
      ok: true,
      payload: { ok: true, key: "global", agentId: "work" },
    });
  } finally {
    if (ws.readyState !== ws.CLOSED) {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  }
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

function identifiedClient(profileId: string, scopes: string[] = ["operator.read"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes,
    },
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

test("sessions.preview returns transcript previews within the requested text budget", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  await writeSessionStore({ entries: { "agent:main:main": sessionStoreEntry(sessionId) } });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "Long preview input crosses the requested character budget." },
      { role: "assistant", content: "Hi" },
      { role: "assistant", content: [{ type: "toolcall", name: "weather" }] },
      { role: "assistant", content: "Forecast ready" },
    ],
  });

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

test("session preview reader widens its bounded tail past filtered tool-result rows", async () => {
  const scope = await seedPreviewTail("sess-preview-sparse-tail", [
    ...Array.from({ length: 64 }, (_, index) => ({
      role: "assistant",
      content: `visible ${String(index)}`,
    })),
    ...Array.from({ length: 320 }, (_, index) => ({
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

test("sessions.resolve by sessionId ignores fuzzy-search list limits and returns the exact match", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, { sessionId: string; updatedAt: number; label?: string }> = {
    "agent:main:subagent:target": {
      sessionId: "sess-target-exact",
      updatedAt: now - 20_000,
    },
  };
  for (let i = 0; i < 9; i += 1) {
    entries[`agent:main:subagent:noisy-${i}`] = {
      sessionId: `sess-noisy-${i}`,
      updatedAt: now - i * 1_000,
      label: `sess-target-exact noisy ${i}`,
    };
  }
  await writeSessionStore({ entries });

  const { ws } = await openClient();
  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    sessionId: "sess-target-exact",
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:main:subagent:target");
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
