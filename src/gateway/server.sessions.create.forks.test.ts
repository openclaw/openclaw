import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished, test } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
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

const forkableClaudeCliBackend = {
  id: "claude-cli",
  pluginId: "anthropic",
  modelProvider: "anthropic",
  config: { command: "claude", forkArg: "--fork-session", resumeAtArg: "--resume-session-at" },
  bundleMcp: false,
  ownsNativeCompaction: false,
} satisfies ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

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
          conversationLink: { url: "https://chat.example.test/main", label: "Main Conversation" },
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
    expect(child.conversationLink).toBeUndefined();
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

test.each([undefined, 2])(
  "sessions.create preserves explicit lineage with spawnDepth %s",
  async (spawnDepth) => {
    const { storePath } = await createSessionStoreDir();
    testState.sessionConfig = { dmScope: "main" };
    const conversationLink = {
      url: "https://chat.example.test/thread/123",
      label: "Source Thread",
    };
    await writeSessionStore({
      entries: {
        "agent:main:explicit-parent": sessionStoreEntry("sess-explicit-parent", {
          conversationLink,
        }),
      },
    });

    const created = await directSessionReq<{
      key?: string;
      entry?: { parentSessionKey?: string; spawnDepth?: number };
    }>("sessions.create", {
      agentId: "main",
      parentSessionKey: "agent:main:explicit-parent",
      spawnDepth,
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:explicit-parent");
    const childKey = requireNonEmptyString(created.payload?.key, "child session key");
    expect(loadSessionEntry({ sessionKey: childKey, storePath })?.conversationLink).toEqual(
      conversationLink,
    );
    // Operator creations with a parent (UI forks/threads) are still roots: only a
    // declared spawnDepth marks spawn lineage.
    expect(created.payload?.entry?.spawnDepth).toBe(spawnDepth ?? 0);

    const reused = await directSessionReq<{
      entry?: { parentSessionKey?: string };
    }>("sessions.create", {
      agentId: "main",
      key: created.payload?.key,
    });

    expect(reused.ok, JSON.stringify(reused.error)).toBe(true);
    expect(reused.payload?.entry?.parentSessionKey).toBe("agent:main:explicit-parent");
    expect(loadSessionEntry({ sessionKey: childKey, storePath })?.conversationLink).toEqual(
      conversationLink,
    );
  },
);

test.each([
  { params: { agentId: "main", spawnDepth: 1 }, message: "spawnDepth requires parentSessionKey" },
  { params: { fork: true }, message: "fork requires parentSessionKey" },
  {
    params: { agentId: "ops", parentSessionKey: "agent:main:missing" },
    message: "unknown parent session: agent:main:missing",
  },
  {
    params: {
      key: "main",
      parentSessionKey: "agent:main:main",
      emitCommandHooks: true,
      task: "hello after replacing parent",
    },
    message: "sessions.create key must differ from parentSessionKey",
  },
  {
    params: { parentSessionKey: "main", forkFrom: "last-completed" },
    message: "forkFrom requires fork=true",
  },
] as const)(
  "sessions.create rejects invalid child intent: $message",
  async ({ params, message }) => {
    await createSessionStoreDir();
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops" }] };
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent-task") } });
    const created = await directSessionReq("sessions.create", params);
    expect(created).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", message } });
  },
);

test.each([
  { session: { dmScope: "per-channel-peer" }, key: undefined },
  { session: { dmScope: "main", scope: "global" }, key: undefined },
  { session: { dmScope: "main" }, key: "main" },
] as const)("sessions.create leaves roots unparented for %j", async ({ session, key }) => {
  testState.sessionConfig = session;
  await createSessionStoreDir();
  const created = await directSessionReq<{
    key?: string;
    entry?: { parentSessionKey?: string };
  }>("sessions.create", { agentId: "main", key });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  if (key) {
    expect(created.payload?.key).toBe("agent:main:main");
  }
  expect(created.payload?.entry?.parentSessionKey).toBeUndefined();
});

test("sessions.create forks the parent transcript into the new session", async () => {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [forkableClaudeCliBackend],
    resolvePluginSetupCliBackend: () => undefined,
  });
  onTestFinished(() => cliBackendsTesting.resetDepsForTest());
  const { dir, storePath } = await createSessionStoreDir();
  testState.sessionConfig = { scope: "per-sender" };
  const parent = await createCompactedSessionFixture(dir);
  const conversationLink = { url: "https://chat.example.test/thread/fork", label: "Source Thread" };
  const projectRoot = path.join(dir, "qa-writer");
  await fs.mkdir(projectRoot);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        conversationLink,
        sessionFile: parent.sessionFile,
        projectId: "qa-writer",
        spawnedCwd: projectRoot,
        sessionRoot: projectRoot,
        totalTokens: 123,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        cliSessionBindings: {
          "claude-cli": { sessionId: "native-parent", resumeCheckpointId: "parent-checkpoint" },
        },
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
    key: "agent:main:dashboard:fork-publication",
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
    cliSessionBindings: {
      "claude-cli": {
        sessionId: "native-parent",
        resumeCheckpointId: "parent-checkpoint",
        forkNextResume: true,
      },
    },
    forkSource: {
      sessionKey: "agent:main:main",
      sessionId: parent.sessionId,
    },
  });
  expect(loadSessionEntry({ sessionKey: key, storePath })).not.toHaveProperty("forkedFromParent");
  const listed = await directSessionReq<{
    sessions?: Array<{
      key: string;
      forkedFromParent?: boolean;
      conversationLink?: typeof conversationLink;
    }>;
  }>("sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.forkedFromParent).toBe(true);
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.conversationLink).toEqual(
    conversationLink,
  );
  testState.sessionConfig = undefined;
});

async function seedSizedForkParent(dir: string, entry: Parameters<typeof sessionStoreEntry>[1]) {
  const parent = await createCompactedSessionFixture(dir);
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(parent.sessionId, {
        sessionFile: parent.sessionFile,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        ...entry,
      }),
    },
  });
}

test.each([
  {
    name: "provider-scoped fallback",
    model: "unresolved-model",
    provider: "unresolved-provider",
    tokens: 200_000,
    window: undefined,
    limit: "200000/100000 tokens",
  },
  {
    name: "inherited large model",
    model: "gpt-large",
    provider: "openai",
    tokens: 391_869,
    window: 922_000,
    limit: undefined,
  },
  {
    name: "explicit small model",
    model: "gpt-small",
    provider: "openai",
    tokens: 150_000,
    window: 128_000,
    limit: "150000/128000 tokens",
  },
  {
    name: "selected window clamps configured capacity",
    model: "gpt-selectable",
    provider: "openai",
    tokens: 300_000,
    window: 200_000,
    limit: "300000/200000 tokens",
  },
])(
  "sessions.create enforces fork capacity: $name",
  async ({ model, provider, tokens, window, limit }) => {
    const { dir } = await createSessionStoreDir();
    testState.sessionConfig = { scope: "per-sender" };
    resetContextWindowCacheForTest();
    onTestFinished(() => {
      resetContextWindowCacheForTest();
      agentDiscoveryMock.models = [];
      testState.sessionConfig = undefined;
    });
    const selectable = model === "gpt-selectable";
    if (!window) {
      applyDiscoveredContextWindows({
        cache: getContextWindowCaches().discoveredTokenCache,
        models: [{ id: model, provider: "other-provider", contextTokens: 300_000 }],
      });
    } else {
      agentDiscoveryMock.models = [
        {
          id: model,
          name: model,
          provider,
          ...(selectable
            ? {
                contextWindows: [
                  { id: "200k", label: "200K", contextWindow: 200_000 },
                  { id: "1m", label: "1M", contextWindow: 1_000_000 },
                ],
                contextWindowDefault: "1m",
              }
            : { contextWindow: window }),
        },
      ];
    }
    const inherited = !window || model === "gpt-large";
    await seedSizedForkParent(dir, {
      totalTokens: tokens,
      ...(inherited ? { providerOverride: provider, modelOverride: model } : {}),
      ...(!window ? { modelOverrideSource: "user" } : {}),
    });
    const cfg = {
      ...getRuntimeConfig(),
      models: {
        providers: { openai: { models: [{ id: model, contextTokens: 1_000_000 }] } },
      },
    };
    const created = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        parentSessionKey: "main",
        fork: true,
        ...(!inherited ? { model: `${provider}/${model}` } : {}),
        ...(selectable ? { contextWindow: "200k" } : {}),
      },
      selectable ? { context: { getRuntimeConfig: () => cfg } } : undefined,
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(limit === undefined);
    if (limit) {
      expect(created.error?.message).toContain(limit);
    }
  },
);

test.each([undefined, "last-completed"] as const)(
  "sessions.create forks an active parent only from a completed prefix: %s",
  async (forkFrom) => {
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
      const created = await directSessionReq<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          parentSessionKey: "main",
          fork: true,
          forkFrom,
        },
      );

      if (!forkFrom) {
        expect(created).toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Parent session main is still active; try again in a moment.",
          },
        });
        return;
      }
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
  },
);

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
