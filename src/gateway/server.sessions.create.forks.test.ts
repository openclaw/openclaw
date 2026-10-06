import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished, test, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { prepareDiscoveredContextTokenCache } from "../agents/context-cache-projection.js";
import { replaceDiscoveredContextTokenCache } from "../agents/context-cache.js";
import { resetContextWindowCacheForTest } from "../agents/context.test-support.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { SessionCatalogProvider } from "../plugins/session-catalog.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import type { GatewaySessionCommitResult } from "./session-create-service.types.js";
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
  getGatewayConfigModule,
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

test("sessions.create parents dashboard sessions to agent main by default", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = undefined;
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
  const child = expectDefined(loadSessionEntry({ sessionKey: key, storePath }), "created session");
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
});

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
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, ops: {} } };
    testState.agentConfig = { sessionStore: { agentId: "main" } };
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent-task") } });
    const created = await directSessionReq("sessions.create", { agentId: "main", ...params });
    expect(created).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", message } });
  },
);

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
      replaceDiscoveredContextTokenCache(
        await prepareDiscoveredContextTokenCache({
          modelCatalog: {
            entries: [{ id: model, provider: "other-provider", contextTokens: 300_000 }],
          },
        }),
      );
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

type CreatedSession = Pick<
  Extract<GatewaySessionCommitResult, { ok: true }>,
  "key" | "entry" | "resolved"
> & { sessionId: string };

function installSessionCatalog(
  resolveCreateSession: NonNullable<SessionCatalogProvider["resolveCreateSession"]>,
  cli = false,
) {
  const registry = createEmptyPluginRegistry();
  if (cli) {
    registry.cliBackends.push({
      pluginId: "anthropic",
      source: "test",
      backend: {
        id: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
    });
  }
  registry.sessionCatalogs.push({
    pluginId: "anthropic",
    source: "test",
    provider: {
      id: "claude",
      label: "Claude Code",
      resolveCreateSession,
      list: vi.fn(async () => []),
      read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    },
  });
  setActivePluginRegistry(registry);
}

test.each(["cli", "enabled", "disabled"] as const)(
  "sessions.create resolves a catalog target server-side with a %s harness",
  async (harness) => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.agentConfig = {
      model: { primary: "anthropic/claude-opus-4-8" },
      models: { "anthropic/claude-opus-4-8": { agentRuntime: { id: "missing-harness" } } },
    };
    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
    ];
    const agentRuntime = harness === "cli" ? "claude-cli" : "fixture-harness";
    let fixture: ReturnType<typeof createColdPluginFixture> | undefined;
    if (harness !== "cli") {
      const rootDir = await fs.mkdtemp(path.join(dir, "catalog-harness-"));
      fixture = createColdPluginFixture({
        rootDir,
        pluginId: "fixture-harness",
        manifest: { activation: { onAgentHarnesses: ["fixture-harness"] } },
      });
      const { writeConfigFile } = await getGatewayConfigModule();
      await writeConfigFile({
        plugins: {
          load: { paths: [rootDir] },
          entries: { "fixture-harness": { enabled: harness === "enabled" } },
        },
      });
    }
    const resolveCreateSession = vi.fn(() => ({
      model: "anthropic/claude-opus-4-8",
      agentRuntime,
    }));
    installSessionCatalog(resolveCreateSession, harness === "cli");
    testState.sessionConfig = { dmScope: "main" };
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent-catalog") } });

    try {
      const created = await directSessionReq<CreatedSession>("sessions.create", {
        agentId: "main",
        catalogId: "claude",
        ...(harness === "cli" ? { parentSessionKey: "main", emitCommandHooks: true } : {}),
      });

      if (fixture) {
        expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
      }
      if (harness === "disabled") {
        expect(created.ok).toBe(false);
        expect(created.error?.message).toContain('requires agent harness "fixture-harness"');
        expect(created.payload).toBeUndefined();
        return;
      }
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.entry).toMatchObject({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-8",
        agentRuntimeOverride: agentRuntime,
        modelSelectionLocked: true,
        pluginOwnerId: "anthropic",
      });
      expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "main" });
      expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
      if (harness === "cli") {
        expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
      }

      const patched = await directSessionReq("sessions.patch", {
        key: created.payload?.key,
        agentId: "main",
        model: "anthropic/claude-opus-4-8",
      });
      expect(patched.ok).toBe(false);
      expect(patched.error).toMatchObject({
        code: "INVALID_REQUEST",
        message: "Model selection is locked for this session.",
      });

      const deleted = await directSessionReq("sessions.delete", {
        key: created.payload?.key,
        agentId: "main",
        deleteTranscript: false,
      });
      expect(deleted.ok).toBe(true);
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey: created.payload?.key ?? "",
          storePath,
        }),
      ).toBeUndefined();
    } finally {
      testState.agentConfig = undefined;
      testState.sessionConfig = undefined;
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  },
);

test.each(["caller key", "unauthorized agent"])(
  "sessions.create rejects a catalog target with %s",
  async (conflict) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentsConfig = { ownership: "explicit", entries: { main: {}, research: {} } };
    const existing = sessionStoreEntry("sess-existing-catalog-target", {
      providerOverride: "openai",
      modelOverride: "gpt-existing",
    });
    await writeSessionStore({ entries: { main: existing } });
    const resolveCreateSession = vi.fn(({ agentId }: { agentId?: string }) =>
      agentId === "research"
        ? undefined
        : { model: "anthropic/claude-opus-4-8", agentRuntime: "claude-cli" },
    );
    installSessionCatalog(resolveCreateSession);
    try {
      const created = await directSessionReq("sessions.create", {
        catalogId: "claude",
        ...(conflict === "caller key" ? { key: "main", agentId: "main" } : { agentId: "research" }),
      });
      expect(created).toMatchObject({
        ok: false,
        error:
          conflict === "caller key"
            ? { code: "INVALID_REQUEST", message: "sessions.create catalogId cannot include key" }
            : { code: "UNAVAILABLE", message: "session catalog claude cannot create sessions" },
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
      ).toMatchObject({
        sessionId: existing.sessionId,
        providerOverride: "openai",
        modelOverride: "gpt-existing",
      });
      if (conflict === "unauthorized agent") {
        expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "research" });
      }
    } finally {
      testState.agentsConfig = undefined;
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  },
);

test.each<{
  name: string;
  defaults: string;
  parent: Partial<SessionEntry>;
  inherited: Partial<SessionEntry>;
  absent: (keyof SessionEntry)[];
  resolved: CreatedSession["resolved"];
}>([
  {
    name: "explicit selection",
    defaults: "anthropic/current-model",
    parent: {
      providerOverride: "codex",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      agentRuntimeOverride: "codex",
      modelProvider: "codex",
      model: "gpt-5.5",
      contextTokens: 272000,
      inputTokens: 12000,
      outputTokens: 340,
      totalTokens: 12340,
      totalTokensFresh: false,
      contextBudgetStatus: {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 1,
        provider: "codex",
        model: "gpt-5.5",
        route: "compact_then_truncate",
        shouldCompact: true,
        estimatedPromptTokens: 250000,
        contextTokenBudget: 128000,
        promptBudgetBeforeReserve: 112000,
        reserveTokens: 16000,
        effectiveReserveTokens: 16000,
        remainingPromptBudgetTokens: 0,
        overflowTokens: 138000,
        toolResultReducibleChars: 5000,
        messageCount: 12,
        unwindowedMessageCount: 12,
      },
      thinkingLevel: "off",
      fastMode: "auto",
      traceLevel: "debug",
      authProfileOverride: "codex-oauth",
      authProfileOverrideSource: "user",
    },
    inherited: {
      providerOverride: "codex",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
      agentRuntimeOverride: "codex",
      thinkingLevel: "off",
      fastMode: "auto",
      traceLevel: "debug",
      authProfileOverride: "codex-oauth",
      authProfileOverrideSource: "user",
    },
    absent: [
      "modelProvider",
      "model",
      "contextTokens",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "totalTokensFresh",
      "contextBudgetStatus",
    ],
    resolved: { modelProvider: "codex", model: "gpt-5.5" },
  },
  {
    name: "automatic fallback",
    defaults: "openai/gpt-primary",
    parent: {
      providerOverride: "google-vertex",
      modelOverride: "gemini-fallback",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-primary",
      agentRuntimeOverride: "vertex-runtime",
      contextWindow: "1m",
      authProfileOverride: "google-vertex:fallback",
      authProfileOverrideSource: "auto",
      thinkingLevel: "high",
    },
    inherited: { contextWindow: "1m", thinkingLevel: "high" },
    absent: [
      "providerOverride",
      "modelOverride",
      "modelOverrideSource",
      "agentRuntimeOverride",
      "authProfileOverride",
      "authProfileOverrideSource",
    ],
    resolved: { modelProvider: "openai", model: "gpt-primary" },
  },
])(
  "sessions.create inherits only durable selection: $name",
  async ({ name, defaults, parent, inherited, absent, resolved }) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentConfig = { model: { primary: defaults } };
    await writeSessionStore({ entries: { main: sessionStoreEntry("sess-parent", parent) } });
    const created = await directSessionReq<CreatedSession>("sessions.create", {
      agentId: "main",
      label: "Fresh Chat",
      parentSessionKey: "main",
    });
    expect(created.ok).toBe(true);
    expect(created.payload?.resolved).toEqual(resolved);
    const key = requireNonEmptyString(created.payload?.key, "created session key");
    const stored = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    for (const entry of [created.payload?.entry, stored]) {
      expect(entry).toMatchObject({ parentSessionKey: "agent:main:main", ...inherited });
      for (const field of absent) {
        expect(entry?.[field], field).toBeUndefined();
      }
    }
    if (name === "explicit selection") {
      const overridden = await directSessionReq<CreatedSession>("sessions.create", {
        agentId: "main",
        fastMode: false,
        parentSessionKey: "main",
      });
      expect(overridden.ok, JSON.stringify(overridden.error)).toBe(true);
      expect(overridden.payload?.entry?.fastMode).toBe(false);
    }
  },
);

test("sessions.create preserves write-scoped fresh selection but gates adopted rows", async () => {
  const { storePath } = await createSessionStoreDir();
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    {
      id: "gpt-test-a",
      name: "A",
      provider: "openai",
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
    },
    { id: "gpt-test-b", name: "B", provider: "openai" },
  ];
  testState.agentConfig = { subagents: { model: "openai/gpt-test-a" } };
  const writeClient = { connect: { scopes: ["operator.write"] } } as never;
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  const unscopedClient = { connect: {} } as never;
  const freshKey = "agent:main:dashboard:fresh-model";
  const existingKey = "agent:main:dashboard:existing-model";
  const existingProfileKey = "agent:main:dashboard:existing-profile-model";
  const existingSubagentKey = "agent:main:subagent:existing-model";
  await writeSessionStore({
    entries: {
      [existingKey]: sessionStoreEntry("sess-existing", {
        contextWindow: "200k",
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
        thinkingLevel: "low",
        fastMode: false,
      }),
      [existingProfileKey]: sessionStoreEntry("sess-existing-profile", {
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
        authProfileOverride: "work",
        authProfileOverrideSource: "user",
      }),
      [existingSubagentKey]: sessionStoreEntry("sess-existing-subagent"),
    },
  });

  const fresh = await directSessionReq<CreatedSession>(
    "sessions.create",
    { key: freshKey, model: "openai/gpt-test-a", fastMode: true },
    { client: writeClient },
  );
  expect(fresh.ok, JSON.stringify(fresh.error)).toBe(true);
  expect(fresh.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    fastMode: true,
  });

  const sameSelection = await directSessionReq<CreatedSession>(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-a", thinkingLevel: "low", fastMode: false },
    { client: writeClient },
  );
  expect(sameSelection.ok, JSON.stringify(sameSelection.error)).toBe(true);
  expect(sameSelection.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    thinkingLevel: "low",
    fastMode: false,
  });

  const sameSubagentSelection = await directSessionReq<CreatedSession>(
    "sessions.create",
    { key: existingSubagentKey, model: "openai/gpt-test-a" },
    { client: writeClient },
  );
  expect(sameSubagentSelection.ok, JSON.stringify(sameSubagentSelection.error)).toBe(true);
  expect(sameSubagentSelection.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
  });

  const sameSelectionWithProfile = await directSessionReq<CreatedSession>(
    "sessions.create",
    { key: existingProfileKey, model: "openai/gpt-test-a" },
    { client: writeClient },
  );
  expect(sameSelectionWithProfile.ok, JSON.stringify(sameSelectionWithProfile.error)).toBe(true);
  expect(sameSelectionWithProfile.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    authProfileOverride: "work",
  });

  const profileDenied = await directSessionReq(
    "sessions.create",
    { key: existingProfileKey, model: "openai/gpt-test-a@other" },
    { client: writeClient },
  );
  expect(profileDenied.ok).toBe(false);
  expect(profileDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const denied = await directSessionReq(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-b" },
    { client: writeClient },
  );
  expect(denied.ok).toBe(false);
  expect(denied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const unscopedDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-b" },
    { client: unscopedClient },
  );
  expect(unscopedDenied.ok).toBe(false);
  expect(unscopedDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  testState.agentConfig = {
    models: {
      "openai/gpt-test-b": { alias: "gpt-test-a" },
    },
  };
  const aliasDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, model: "gpt-test-a" },
    { client: writeClient },
  );
  expect(aliasDenied.ok).toBe(false);
  expect(aliasDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  expect(loadSessionEntry({ sessionKey: existingKey, storePath })).toMatchObject({
    sessionId: "sess-existing",
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    thinkingLevel: "low",
  });
  expect(loadSessionEntry({ sessionKey: existingProfileKey, storePath })).toMatchObject({
    sessionId: "sess-existing-profile",
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
    authProfileOverride: "work",
  });

  const thinkingDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, thinkingLevel: "high" },
    { client: writeClient },
  );
  expect(thinkingDenied.ok).toBe(false);
  expect(thinkingDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const fastModeDenied = await directSessionReq(
    "sessions.create",
    { key: existingKey, fastMode: true },
    { client: writeClient },
  );
  expect(fastModeDenied.ok).toBe(false);
  expect(fastModeDenied.error).toMatchObject({
    code: "FORBIDDEN",
    message: "missing scope: operator.admin",
  });

  const admin = await directSessionReq<CreatedSession>(
    "sessions.create",
    { key: existingKey, model: "openai/gpt-test-b", thinkingLevel: "high", fastMode: true },
    { client: adminClient },
  );
  expect(admin.ok, JSON.stringify(admin.error)).toBe(true);
  expect(admin.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-b",
    thinkingLevel: "high",
    fastMode: true,
  });
  expect(admin.payload?.entry?.contextWindow).toBeUndefined();
  const stored = loadSessionEntry({ sessionKey: existingKey, storePath });
  expect(stored?.modelOverride).toBe("gpt-test-b");
  expect(stored?.contextWindow).toBeUndefined();
});
