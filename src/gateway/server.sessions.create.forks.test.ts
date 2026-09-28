import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { getContextWindowCaches } from "../agents/context-cache.js";
import {
  applyDiscoveredContextWindows,
  resetContextWindowCacheForTest,
} from "../agents/context.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import {
  agentDiscoveryMock,
  embeddedRunMock,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  createCompactedSessionFixture,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateTestHarness();

test.each([undefined, "main"])(
  "sessions.create parents dashboard sessions to agent main when dmScope is %s",
  async (dmScope) => {
    const { storePath } = await createSessionStoreDir();
    testState.sessionConfig = dmScope ? { dmScope } : undefined;
    testState.agentConfig = { model: { primary: "openai/current-model" } };
    await writeSessionStore({
      entries: {
        "agent:main:main": {
          ...sessionStoreEntry("sess-grouping-parent"),
          providerOverride: "anthropic",
          modelOverride: "parent-model",
          modelOverrideSource: "user",
        },
      },
    });

    const created = await directSessionReq<{
      key?: string;
      entry?: { parentSessionKey?: string; spawnDepth?: number };
      resolved?: { modelProvider?: string; model?: string };
    }>("sessions.create", { agentId: "main" });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
    // Auto-parented operator sessions must stay depth-zero roots. This preserves
    // their operator identity and makes explicit finite spawn-depth caps apply
    // from the correct origin.
    expect(created.payload?.entry?.spawnDepth).toBe(0);
    const key = requireNonEmptyString(created.payload?.key, "created session key");
    const child = expectDefined(
      loadSessionEntry({ sessionKey: key, storePath }),
      "created session",
    );
    const parent = expectDefined(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath }),
      "grouping parent session",
    );
    const { createModelSelectionState } = await import("../auto-reply/reply/model-selection.js");
    const cfg = getRuntimeConfig();
    const reply = await createModelSelectionState({
      cfg,
      agentId: "main",
      agentCfg: cfg.agents?.defaults,
      sessionEntry: child,
      sessionStore: { "agent:main:main": parent },
      sessionKey: key,
      parentSessionKey: child.parentSessionKey,
      defaultProvider: "openai",
      defaultModel: "current-model",
      provider: "openai",
      model: "current-model",
      hasModelDirective: false,
    });
    expect(created.payload?.resolved).toMatchObject({
      modelProvider: "openai",
      model: "current-model",
    });
    expect({ provider: reply.provider, model: reply.model }).toEqual({
      provider: "openai",
      model: "current-model",
    });
  },
);

test("sessions.create preserves an explicit parent under main dmScope", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main" };
  await writeSessionStore({
    entries: {
      "agent:main:explicit-parent": sessionStoreEntry("sess-explicit-parent"),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    entry?: { parentSessionKey?: string; spawnDepth?: number };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "agent:main:explicit-parent",
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:explicit-parent");
  // Operator creations with a parent (UI forks/threads) are still roots: only a
  // declared spawnDepth marks spawn lineage.
  expect(created.payload?.entry?.spawnDepth).toBe(0);

  const reused = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", {
    agentId: "main",
    key: created.payload?.key,
  });

  expect(reused.ok, JSON.stringify(reused.error)).toBe(true);
  expect(reused.payload?.entry?.parentSessionKey).toBe("agent:main:explicit-parent");
});

test("sessions.create persists declared spawn lineage for spawn-owned creations", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main" };
  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry("sess-spawn-parent"),
    },
  });

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string; spawnDepth?: number };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "agent:main:main",
    spawnDepth: 2,
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.spawnDepth).toBe(2);
});

test("sessions.create rejects spawnDepth without parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    spawnDepth: 1,
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    message: "spawnDepth requires parentSessionKey",
  });
});

test("sessions.create leaves dashboard sessions unparented under per-channel-peer dmScope", async () => {
  testState.sessionConfig = { dmScope: "per-channel-peer" };
  await createSessionStoreDir();

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create leaves dashboard sessions unparented under global session scope", async () => {
  testState.sessionConfig = { dmScope: "main", scope: "global" };
  await createSessionStoreDir();

  const created = await directSessionReq<{
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create does not parent the main session to itself", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await createSessionStoreDir();

  const created = await directSessionReq<{
    key?: string;
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main", key: "main" });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.key).toBe("agent:main:main");
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create rejects unknown parentSessionKey", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops" }] };

  const created = await directSessionReq("sessions.create", {
    agentId: "ops",
    parentSessionKey: "agent:main:missing",
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "unknown parent session",
  );
});

test("sessions.create forks the parent transcript into the new session", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parent = await createCompactedSessionFixture(dir);
  const projectRoot = path.join(dir, "qa-writer");
  await fs.mkdir(projectRoot);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        projectId: "qa-writer",
        spawnedCwd: projectRoot,
        sessionRoot: projectRoot,
        totalTokens: 123,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });
  await seedSessionTranscript({
    sessionId: parent.sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "before compaction" },
      { role: "assistant", content: [{ type: "text", text: "working on it" }] },
    ],
  });

  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      sessionFile?: string;
      parentSessionKey?: string;
      forkSource?: { sessionKey: string; sessionId: string };
      forkedFromParent?: boolean;
      totalTokens?: number;
      totalTokensFresh?: boolean;
    };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.forkSource).toEqual({
    sessionKey: "agent:main:main",
    sessionId: parent.sessionId,
  });
  expect(created.payload?.entry?.forkedFromParent).toBe(true);
  expect(created.payload?.entry?.totalTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokensFresh).toBe(false);
  expect(created.payload?.sessionId).not.toBe(parent.sessionId);
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");
  const readMessages = async (scope: {
    sessionFile?: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) =>
    (await loadTranscriptEvents(scope))
      .filter((entry): entry is { type: "message"; message: unknown } => {
        return (
          entry !== null &&
          typeof entry === "object" &&
          "type" in entry &&
          entry.type === "message" &&
          "message" in entry
        );
      })
      .map((entry) => entry.message);
  const forkedSessionId = requireNonEmptyString(created.payload?.sessionId, "forked session id");
  expect(
    await readMessages({
      sessionId: forkedSessionId,
      sessionKey: created.payload?.key ?? "",
      storePath,
    }),
  ).toEqual(
    await readMessages({
      sessionId: parent.sessionId,
      sessionKey: "agent:main:main",
      storePath,
    }),
  );

  const key = requireNonEmptyString(created.payload?.key, "forked session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
    projectId: "qa-writer",
    spawnedCwd: projectRoot,
    sessionRoot: projectRoot,
    sessionId: created.payload?.sessionId,
    forkSource: {
      sessionKey: "agent:main:main",
      sessionId: parent.sessionId,
    },
  });
  expect(loadSessionEntry({ sessionKey: key, storePath })).not.toHaveProperty("forkedFromParent");
  const listed = await directSessionReq<{
    sessions?: Array<{ key: string; forkedFromParent?: boolean }>;
  }>("sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.forkedFromParent).toBe(true);
  testState.sessionConfig = undefined;
});

test("sessions.create rejects fork without parentSessionKey", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", { fork: true });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "fork requires parentSessionKey",
  });
});

test("sessions.create rejects forkFrom without fork", async () => {
  await createSessionStoreDir();

  const created = await directSessionReq("sessions.create", {
    parentSessionKey: "main",
    forkFrom: "last-completed",
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "forkFrom requires fork=true",
  });
});

test("sessions.create retains the 100K fallback when only another provider has model capacity", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  resetContextWindowCacheForTest();
  applyDiscoveredContextWindows({
    cache: getContextWindowCaches().discoveredTokenCache,
    models: [{ id: "unresolved-model", provider: "other-provider", contextTokens: 300_000 }],
  });
  const parent = await createCompactedSessionFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        providerOverride: "unresolved-provider",
        modelOverride: "unresolved-model",
        modelOverrideSource: "user",
        // Fresh persisted usage above DEFAULT_PARENT_FORK_MAX_TOKENS (100K).
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });

  try {
    const created = await directSessionReq("sessions.create", {
      agentId: "main",
      parentSessionKey: "main",
      fork: true,
    });

    expect(created.ok).toBe(false);
    expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
      "200000/100000 tokens",
    );
  } finally {
    resetContextWindowCacheForTest();
    testState.sessionConfig = undefined;
  }
});

test("sessions.create admits an explicit fork within the child model context window", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  agentDiscoveryMock.models = [
    { id: "gpt-large", name: "Large", provider: "openai", contextWindow: 922_000 },
  ];
  const parent = await createCompactedSessionFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        providerOverride: "openai",
        modelOverride: "gpt-large",
        totalTokens: 391_869,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  agentDiscoveryMock.models = [];
  testState.sessionConfig = undefined;
});

test("sessions.create rejects an explicit fork above the selected child model window", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  agentDiscoveryMock.models = [
    { id: "gpt-small", name: "Small", provider: "openai", contextWindow: 128_000 },
  ];
  const parent = await createCompactedSessionFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        totalTokens: 150_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });

  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    model: "openai/gpt-small",
    parentSessionKey: "main",
    fork: true,
  });

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "150000/128000 tokens",
  );
  agentDiscoveryMock.models = [];
  testState.sessionConfig = undefined;
});

test("sessions.create clamps configured capacity to the selected child model window", async () => {
  const { dir } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  agentDiscoveryMock.models = [
    {
      id: "gpt-selectable",
      name: "Selectable",
      provider: "openai",
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
    },
  ];
  const parent = await createCompactedSessionFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        totalTokens: 300_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });
  const cfg = {
    ...getRuntimeConfig(),
    models: {
      providers: {
        openai: { models: [{ id: "gpt-selectable", contextTokens: 1_000_000 }] },
      },
    },
  };

  const created = await directSessionReq(
    "sessions.create",
    {
      agentId: "main",
      contextWindow: "200k",
      fork: true,
      model: "openai/gpt-selectable",
      parentSessionKey: "main",
    },
    {
      context: {
        getRuntimeConfig: () => cfg,
      },
    },
  );

  expect(created.ok).toBe(false);
  expect((created.error as { message?: string } | undefined)?.message ?? "").toContain(
    "300000/200000 tokens",
  );
  agentDiscoveryMock.models = [];
  testState.sessionConfig = undefined;
});

test("sessions.create rejects fork while the parent session is active", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parentSessionId = "sess-active-fork-parent";
  await writeSessionStore({ entries: { main: sessionStoreEntry(parentSessionId) } });
  embeddedRunMock.activeIds.add(parentSessionId);
  try {
    const created = await directSessionReq("sessions.create", {
      parentSessionKey: "main",
      fork: true,
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Parent session main is still active; try again in a moment.",
    });
  } finally {
    embeddedRunMock.activeIds.delete(parentSessionId);
    testState.sessionConfig = undefined;
  }
});

test("sessions.create forks an active parent from its last completed message", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parentSessionId = "sess-active-completed-fork-parent";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parentSessionId, {
        // The in-flight tail can make the whole parent exceed the cap; only the
        // selected completed prefix should govern this fork.
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    },
  });
  await seedSessionTranscript({
    sessionId: parentSessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "completed question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "completed answer" }],
        stopReason: "stop",
      },
      { role: "user", content: "active question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "active tool call" }],
        stopReason: "toolUse",
      },
    ],
  });
  embeddedRunMock.activeIds.add(parentSessionId);
  try {
    const created = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
      parentSessionKey: "main",
      fork: true,
      forkFrom: "last-completed",
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const messages = await loadTranscriptEvents({
      sessionId: created.payload?.sessionId ?? "",
      sessionKey: created.payload?.key ?? "",
      storePath,
    });
    expect(
      messages.flatMap((entry) =>
        entry &&
        typeof entry === "object" &&
        "type" in entry &&
        entry.type === "message" &&
        "message" in entry
          ? [entry.message]
          : [],
      ),
    ).toEqual([
      expect.objectContaining({ role: "user", content: "completed question" }),
      expect.objectContaining({ role: "assistant", stopReason: "stop" }),
    ]);
  } finally {
    embeddedRunMock.activeIds.delete(parentSessionId);
    testState.sessionConfig = undefined;
  }
});

test("sessions.create resolves an agent-qualified fork from the parent store", async () => {
  const { dir } = await createSessionStoreDir();
  const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
  const mainStorePath = storeTemplate.replace("{agentId}", "main");
  const workStorePath = storeTemplate.replace("{agentId}", "work");
  const workDir = path.dirname(workStorePath);
  testState.sessionStorePath = storeTemplate;
  testState.sessionConfig = { scope: "per-sender" };
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  try {
    await fs.mkdir(workDir, { recursive: true });
    const parent = await createCompactedSessionFixture(workDir);
    await writeSessionStore({
      storePath: workStorePath,
      agentId: "work",
      entries: {
        main: sessionStoreEntry(parent.sessionId, { sessionFile: parent.sessionFile }),
      },
    });
    await seedSessionTranscript({
      agentId: "work",
      sessionId: parent.sessionId,
      sessionKey: "agent:work:main",
      storePath: workStorePath,
      messages: [
        { role: "user", content: "before compaction" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ],
    });

    const created = await directSessionReq<{
      key?: string;
      sessionId?: string;
      entry?: {
        parentSessionKey?: string;
        sessionFile?: string;
        forkSource?: { sessionKey: string; sessionId: string };
        forkedFromParent?: boolean;
      };
    }>("sessions.create", {
      parentSessionKey: "agent:work:main",
      fork: true,
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:work:main");
    expect(created.payload?.entry?.forkSource).toEqual({
      sessionKey: "agent:work:main",
      sessionId: parent.sessionId,
    });
    expect(created.payload?.entry?.forkedFromParent).toBe(true);
    expect(created.payload?.entry).not.toHaveProperty("sessionFile");
    await expect(
      loadTranscriptEvents({
        sessionId: requireNonEmptyString(
          created.payload?.sessionId,
          "agent-qualified forked session id",
        ),
        sessionKey: created.payload?.key ?? "",
        storePath: mainStorePath,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ content: "before compaction" }),
          type: "message",
        }),
      ]),
    );
  } finally {
    testState.sessionStorePath = undefined;
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  }
});

test("sessions.create rejects replacing its parent key", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent-task") } });

  const created = await directSessionReq("sessions.create", {
    key: "main",
    parentSessionKey: "agent:main:main",
    emitCommandHooks: true,
    task: "hello after replacing parent",
  });

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: "sessions.create key must differ from parentSessionKey",
  });
});
