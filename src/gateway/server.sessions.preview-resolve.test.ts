import { expect, onTestFinished, test } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { GatewayClient } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
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
