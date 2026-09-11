/**
 * Gateway session store RPC tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import * as sessionDirs from "../agents/session-dirs.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { CronJob } from "../cron/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { agentDiscoveryMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq as directSessionHandlerReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, defaultAgentWorkspace, openClient } =
  setupGatewaySessionsTestHarness();
test("sessions.list configuredAgentsOnly keeps configured-agent children and hides unrelated stores", async () => {
  const rootStateDir = expectDefined(process.env.OPENCLAW_STATE_DIR, "OPENCLAW_STATE_DIR");
  const stateDir = path.join(rootStateDir, "configured-list-regression");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    testState.agentsConfig = { ownership: "explicit", list: [{ id: "ops" }] };
    testState.agentConfig = { sessionStore: { agentId: "ops" } };
    const configPath = expectDefined(process.env.OPENCLAW_CONFIG_PATH, "OPENCLAW_CONFIG_PATH");
    const configJson = '{"acp":{"defaultAgent":"claude","allowedAgents":["gemini"]}}';
    await fs.writeFile(configPath, configJson, "utf-8");
    const agentsDir = path.join(stateDir, "agents");
    const storeTemplate = path.join(agentsDir, "{agentId}", "sessions", "sessions.json");
    testState.sessionConfig = { store: storeTemplate };

    const acpStorePath = path.join(agentsDir, "claude", "sessions", "sessions.json");
    const childStorePath = path.join(agentsDir, "codex", "sessions", "sessions.json");
    const diskOnlyStorePath = path.join(agentsDir, "local", "sessions", "sessions.json");
    const mainKey = "agent:ops:main";
    const acpKey = "agent:claude:acp:25f77580-de30-4d80-9bc3-7cbc6374bce7";
    const acp = {
      backend: "acpx",
      agent: "claude",
      runtimeSessionName: acpKey,
      mode: "oneshot",
      state: "idle",
      lastActivityAt: 30,
    } as const;
    const spawnedChildKey = "agent:codex:subagent:app-server-child";
    const parentChildKey = "agent:codex:subagent:parent-key-child";
    await writeSessionStore({
      storePath: path.join(agentsDir, "ops", "sessions", "sessions.json"),
      agentId: "ops",
      entries: { main: { sessionId: "sess-main", updatedAt: 20 } },
    });
    await writeSessionStore({
      storePath: acpStorePath,
      agentId: "claude",
      entries: {
        [acpKey]: { sessionId: "sess-claude-acp", updatedAt: 30, acp },
      },
    });
    await writeSessionStore({
      storePath: childStorePath,
      agentId: "codex",
      entries: {
        [spawnedChildKey]: { sessionId: "sess-codex-child", updatedAt: 25, spawnedBy: mainKey },
        [parentChildKey]: { sessionId: "child-2", updatedAt: 27, parentSessionKey: mainKey },
      },
    });
    await writeSessionStore({
      storePath: diskOnlyStorePath,
      agentId: "local",
      entries: { main: { sessionId: "sess-local", updatedAt: 10 } },
    });
    const enumerateAgentDirs = vi.spyOn(sessionDirs, "resolveAgentSessionDirsFromAgentsDirSync");
    try {
      const configuredOnly = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
        "sessions.list",
        { includeGlobal: false, includeUnknown: false, configuredAgentsOnly: true },
      );
      expect(configuredOnly.ok).toBe(true);
      expect(configuredOnly.payload?.sessions.map((session) => session.key)).toEqual([
        acpKey,
        parentChildKey,
        spawnedChildKey,
        mainKey,
      ]);
      expect(enumerateAgentDirs).not.toHaveBeenCalled();

      const broad = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
        "sessions.list",
        { includeGlobal: false, includeUnknown: false },
      );
      expect(broad.ok).toBe(true);
      expect(broad.payload?.sessions.map((session) => session.key)).toEqual([
        acpKey,
        parentChildKey,
        spawnedChildKey,
        mainKey,
        "agent:local:main",
      ]);
      expect(enumerateAgentDirs).toHaveBeenCalled();
    } finally {
      enumerateAgentDirs.mockRestore();
    }
  });
});

test("sessions.list hides phantom agent store placeholder rows", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      sessions: {},
      main: {
        sessionId: "sess-main",
        updatedAt: 20,
      },
    },
  });

  const listed = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions.map((session) => session.key)).toEqual(["agent:main:main"]);
});

test("write-scoped operators manage chat organization but not admin session settings", async () => {
  const { storePath } = await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: now },
      "topic-a": {
        sessionId: "sess-topic-a",
        updatedAt: now - 60_000,
        // Stored channel-derived name; a user rename (label) must beat it.
        displayName: "channel topic",
      },
      "topic-b": { sessionId: "sess-topic-b", updatedAt: now - 30_000 },
    },
  });

  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

  const { ws } = await openClient({ scopes: ["operator.write"] });
  try {
    const renamed = await rpcReq<{
      ok: true;
      entry: { label?: string; modelOverride?: string; providerOverride?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Trip planning",
      model: "openai/gpt-test-a",
    });
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    expect(renamed.payload?.entry).toMatchObject({
      label: "Trip planning",
      modelOverride: "gpt-test-a",
      providerOverride: "openai",
    });

    const pinned = await rpcReq<{ ok: true; entry: { pinnedAt?: number } }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      pinned: true,
    });
    expect(pinned.ok).toBe(true);
    expect(pinned.payload?.entry.pinnedAt).toEqual(expect.any(Number));

    const organized = await rpcReq<{
      ok: true;
      entry: { category?: string; markedUnreadAt?: number };
    }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      category: "Travel",
      unread: true,
    });
    expect(organized.ok).toBe(true);
    expect(organized.payload?.entry.category).toBe("Travel");

    // Patched categories are absorbed into the gateway group catalog.
    const groupsAfterPatch = await rpcReq<{
      groups: Array<{ name: string; position: number }>;
      sectionOrder: string[];
    }>(ws, "sessions.groups.list", {});
    expect(groupsAfterPatch.ok).toBe(true);
    expect(groupsAfterPatch.payload?.groups).toContainEqual({ name: "Travel", position: 0 });
    expect(groupsAfterPatch.payload?.sectionOrder).toEqual([]);

    const reordered = await rpcReq<{
      ok: true;
      groups: Array<{ name: string }>;
      sectionOrder: string[];
    }>(ws, "sessions.groups.put", {
      names: ["Someday", "Travel"],
      sectionOrder: ["work", "category:Travel", "category:Missing", "ungrouped"],
    });
    expect(reordered.ok).toBe(true);
    expect(reordered.payload?.groups.map((group) => group.name)).toEqual(["Someday", "Travel"]);
    expect(reordered.payload?.sectionOrder).toEqual(["work", "category:Travel", "ungrouped"]);

    const canonicalDefaultAgentWorkspace = await fs.realpath(defaultAgentWorkspace);
    const defaultsUpdated = await rpcReq<{
      ok: true;
      defaults: Array<{ name: string; cwd?: string; worktree?: boolean }>;
    }>(ws, "sessions.groups.update", {
      name: "Travel",
      cwd: defaultAgentWorkspace,
      worktree: true,
    });
    expect(defaultsUpdated.ok).toBe(true);
    expect(defaultsUpdated.payload?.defaults).toContainEqual({
      name: "Travel",
      cwd: canonicalDefaultAgentWorkspace,
      worktree: true,
    });
    const renamedGroup = await rpcReq<{
      ok: true;
      sectionOrder: string[];
      updatedSessions?: number;
    }>(ws, "sessions.groups.rename", { name: "Travel", to: "Trips" });
    expect(renamedGroup.ok).toBe(true);
    expect(renamedGroup.payload?.updatedSessions).toBe(1);
    expect(renamedGroup.payload?.sectionOrder).toEqual(["work", "category:Trips", "ungrouped"]);
    const describedAfterRename = await rpcReq<{ session?: { category?: string } }>(
      ws,
      "sessions.describe",
      { key: "agent:main:topic-a" },
    );
    expect(describedAfterRename.ok).toBe(true);
    expect(describedAfterRename.payload?.session?.category).toBe("Trips");

    const deletedGroup = await rpcReq<{
      ok: true;
      sectionOrder: string[];
      updatedSessions?: number;
    }>(ws, "sessions.groups.delete", { name: "Trips" });
    expect(deletedGroup.ok).toBe(true);
    expect(deletedGroup.payload?.updatedSessions).toBe(1);
    expect(deletedGroup.payload?.sectionOrder).toEqual(["work", "ungrouped"]);

    const archived = await rpcReq<{ ok: true; entry: { archivedAt?: number } }>(
      ws,
      "sessions.patch",
      { key: "agent:main:topic-b", archived: true, expectedSessionId: "sess-topic-b" },
    );
    expect(archived.ok).toBe(true);
    expect(archived.payload?.entry.archivedAt).toEqual(expect.any(Number));

    const searched = await rpcReq<{
      sessions: Array<{ key: string; pinned?: boolean; displayName?: string }>;
    }>(ws, "sessions.list", { search: "trip plan" });
    expect(searched.ok).toBe(true);
    expect(searched.payload?.sessions.map((session) => session.key)).toEqual([
      "agent:main:topic-a",
    ]);
    expect(searched.payload?.sessions[0]?.displayName).toBe("Trip planning");

    const archivedList = await rpcReq<{ sessions: Array<{ key: string }> }>(ws, "sessions.list", {
      archived: true,
    });
    expect(archivedList.ok).toBe(true);
    expect(archivedList.payload?.sessions.map((session) => session.key)).toEqual([
      "agent:main:topic-b",
    ]);

    const unflaggedDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-b",
    });
    expect(unflaggedDeleteDenied.ok).toBe(false);
    expect(unflaggedDeleteDenied.error?.message).toContain("missing scope: operator.admin");

    const activeDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-a",
      archivedOnly: true,
    });
    expect(activeDeleteDenied.ok).toBe(false);
    expect(activeDeleteDenied.error?.message).toContain("Archive it first");

    const archivedDeleted = await rpcReq<{ ok: true }>(ws, "sessions.delete", {
      key: "agent:main:topic-b",
      archivedOnly: true,
    });
    expect(archivedDeleted.ok).toBe(true);
    const archivedAfterDelete = await rpcReq<{ sessions: Array<{ key: string }> }>(
      ws,
      "sessions.list",
      { archived: true },
    );
    expect(archivedAfterDelete.payload?.sessions).toEqual([]);

    const adminFieldDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      sendPolicy: "deny",
    });
    expect(adminFieldDenied.ok).toBe(false);
    expect(adminFieldDenied.error?.message).toContain("missing scope: operator.admin");

    const mixedFieldsDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Sneaky",
      model: null,
      thinkingLevel: "high",
    });
    expect(mixedFieldsDenied.ok).toBe(false);
    expect(mixedFieldsDenied.error?.message).toContain("missing scope: operator.admin");
    expect(loadSessionEntry({ sessionKey: "agent:main:topic-a", storePath })).toMatchObject({
      label: "Trip planning",
      modelOverride: "gpt-test-a",
      providerOverride: "openai",
    });
    // Sticky configured-default persistence is handler policy and is covered by
    // sessions-mutations.sticky-model.test.ts; this dispatch proof asserts session state only.
  } finally {
    ws.close();
  }
});

test("sessions.list breaks timestamp ties by key for stable paging", async () => {
  await createSessionStoreDir();
  const updatedAt = Date.now() - 5_000;
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt },
      "tie-c": { sessionId: "sess-tie-c", updatedAt },
      "tie-a": { sessionId: "sess-tie-a", updatedAt },
      "tie-b": { sessionId: "sess-tie-b", updatedAt },
    },
  });

  const expectedOrder = [
    "agent:main:main",
    "agent:main:tie-a",
    "agent:main:tie-b",
    "agent:main:tie-c",
  ];
  const listed = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions.map((session) => session.key)).toEqual(expectedOrder);

  const paged = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false, limit: 2, offset: 2 },
  );
  expect(paged.ok).toBe(true);
  expect(paged.payload?.sessions.map((session) => session.key)).toEqual(expectedOrder.slice(2));
});

test("archiving a session disables cron jobs bound to it", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: now },
      "agent:main:subagent:cronbound": {
        sessionId: "sess-bound",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      },
    },
  });
  const jobs = [
    { id: "bound", enabled: true, sessionTarget: "session:agent:main:subagent:cronbound" },
    { id: "elsewhere", enabled: true, sessionTarget: "isolated" },
  ] as unknown as CronJob[];
  const update = vi.fn(
    async (id: string, _patch: unknown, precondition: (job: CronJob, nowMs: number) => void) => {
      const current = jobs.find((candidate) => candidate.id === id);
      if (!current) {
        throw new Error(`cron job not found: ${id}`);
      }
      precondition(current, Date.now());
      return current;
    },
  );
  const cron = {
    list: async () => jobs,
    updateWithPrecondition: update,
    getDefaultAgentId: () => "main",
  };

  const archived = await directSessionHandlerReq(
    "sessions.patch",
    {
      key: "agent:main:subagent:cronbound",
      archived: true,
      expectedSessionId: "sess-bound",
    },
    { context: { cron } },
  );
  expect(archived.ok).toBe(true);
  expect(update.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["bound", { enabled: false }],
  ]);

  // Restoring must not silently re-arm schedules that archive disabled.
  update.mockClear();
  const restored = await directSessionHandlerReq(
    "sessions.patch",
    {
      key: "agent:main:subagent:cronbound",
      archived: false,
      expectedSessionId: "sess-bound",
    },
    { context: { cron } },
  );
  expect(restored.ok).toBe(true);
  expect(update).not.toHaveBeenCalled();

  // Cron mutations are admin surface: a write-scoped operator can archive but
  // must not cascade into disabling admin-managed schedules.
  const writeScopedClient = {
    connect: { scopes: ["operator.write"] },
  } as unknown as NonNullable<Parameters<typeof directSessionHandlerReq>[2]>["client"];
  const writeScopedArchive = await directSessionHandlerReq(
    "sessions.patch",
    {
      key: "agent:main:subagent:cronbound",
      archived: true,
      expectedSessionId: "sess-bound",
    },
    { context: { cron }, client: writeScopedClient },
  );
  expect(writeScopedArchive.ok).toBe(true);
  expect(update).not.toHaveBeenCalled();
});
