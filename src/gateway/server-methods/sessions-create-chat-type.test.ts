import { afterEach, expect, test } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveMemoryAudienceFromEntry } from "../../plugins/memory-audience.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createGatewaySession } from "../session-create-service.js";
import { disposeSessionReadContexts } from "../session-read-contexts.test-support.js";
import { loadGatewayTestConfig } from "../test-helpers.config-runtime.js";
import { testState, writeSessionStore } from "../test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  seedLinearSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  testState.sessionConfig = undefined;
  await disposeSessionReadContexts();
  await closeOpenClawStateDatabaseAsync();
});

async function useSessionConfig(sessionConfig: Record<string, unknown> | undefined) {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = sessionConfig;
  setRuntimeConfigSnapshot(loadGatewayTestConfig());
  return storePath;
}

async function create(
  params: Record<string, unknown>,
  client?: ReturnType<typeof createSyntheticPluginRuntimeClient>,
) {
  const created = await directSessionReq<{ key: string; entry: { chatType?: string } }>(
    "sessions.create",
    { agentId: "main", ...params },
    client ? { client } : undefined,
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.payload!;
}

// Memory audience resolution reads the root's durable chat type; a root created
// without a message and later driven by sessions_send or cron must not lack it,
// whichever dmScope or session scope the Gateway uses.
test.each([
  { name: "dmScope main", sessionConfig: undefined, parent: "agent:main:main" },
  { name: "dmScope per-channel-peer", sessionConfig: { dmScope: "per-channel-peer" } },
  { name: "global session scope", sessionConfig: { scope: "global" } },
])("records an operator-created root as a direct chat under $name", async (params) => {
  const storePath = await useSessionConfig(params.sessionConfig);
  const created = await create({});
  expect(created.entry.chatType).toBe("direct");
  const entry = loadSessionEntry({ agentId: "main", storePath, sessionKey: created.key });
  expect(entry).toMatchObject({ createdVia: "operator", chatType: "direct" });
  // Grouping under main keeps its own dmScope gate.
  expect(entry?.parentSessionKey).toBe(params.parent);
});

test("a per-channel-peer operator root resolves memory audience from the turn's owner status", async () => {
  const storePath = await useSessionConfig({ dmScope: "per-channel-peer" });
  const { key: sessionKey } = await create({});
  const entry = loadSessionEntry({ agentId: "main", storePath, sessionKey })!;
  const resolve = async (senderIsOwner: boolean) => {
    const resolution = await resolveMemoryAudienceFromEntry(
      { agentId: "main", sessionKey, sessionId: entry.sessionId, senderIsOwner, storePath },
      entry,
    );
    if (resolution.status !== "granted") {
      throw new Error(resolution.reason);
    }
    resolution.release();
    return resolution.audience;
  };
  // Chat type grants nothing by itself: a non-owner turn gets the session's partition.
  expect(await resolve(false)).toEqual({
    kind: "conversation",
    agentId: "main",
    sessionKey,
    sessionId: entry.sessionId,
  });
  expect(await resolve(true)).toEqual({ kind: "owner-private", agentId: "main" });
});

test("incognito, forked, child, spawned and plugin-owned creations do not take the stamp", async () => {
  const storePath = await useSessionConfig({ dmScope: "per-channel-peer" });
  // A parent without a chat type, so a child could only gain one from creation.
  const parentKey = "agent:main:dashboard:untyped-parent";
  const parentSessionId = crypto.randomUUID();
  await writeSessionStore({
    entries: { "dashboard:untyped-parent": sessionStoreEntry(parentSessionId) },
  });
  await seedLinearSessionTranscript({
    sessionId: parentSessionId,
    sessionKey: parentKey,
    storePath,
    contents: ["hello"],
  });
  // Incognito rows live outside the durable store; the creation receipt carries the row.
  const incognito = await create({ incognito: true });
  expect(incognito.key).toContain(":dashboard:incognito-");
  expect(incognito.entry.chatType).toBeUndefined();
  const { key: forked } = await create({ parentSessionKey: parentKey, fork: true });
  const { key: child } = await create({ parentSessionKey: parentKey });
  const { key: spawned } = await create(
    { parentSessionKey: parentKey },
    createSyntheticPluginRuntimeClient({
      scopes: ["operator.write"],
      operatorRoleActor: { kind: "system" },
      sessionCreation: {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: parentKey,
      },
    }),
  );
  const pluginKey = "agent:main:plugin-owned";
  const pluginOwned = await createGatewaySession({
    cfg: loadGatewayTestConfig(),
    agentId: "main",
    key: pluginKey,
    operatorRoleActor: { kind: "system" },
    creation: { via: "operator" },
    authorizedPluginId: "memory-core",
    initialEntry: { pluginOwnerId: "memory-core" },
    commandSource: "plugin-runtime",
  });
  expect(pluginOwned.ok, JSON.stringify(!pluginOwned.ok && pluginOwned.error)).toBe(true);
  const created = [
    [forked, undefined],
    [child, "operator"],
    [spawned, "spawn"],
    [pluginKey, "operator"],
  ] as const;
  for (const [sessionKey, createdVia] of created) {
    const entry = loadSessionEntry({ agentId: "main", storePath, sessionKey });
    expect(entry, sessionKey).toBeDefined();
    expect(entry?.chatType, sessionKey).toBeUndefined();
    if (createdVia) {
      expect(entry?.createdVia, sessionKey).toBe(createdVia);
    }
  }
});
