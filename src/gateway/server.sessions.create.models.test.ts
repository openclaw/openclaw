import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  setupSessionCreateTestHarness,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { agentDiscoveryMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateTestHarness();

test("sessions.create stores dashboard model, thinking, fast mode, and parent linkage", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops" }] };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
      providerOverride?: string;
      modelOverride?: string;
      thinkingLevel?: string;
      fastMode?: boolean | "auto";
      parentSessionKey?: string;
      sessionFile?: string;
    };
  }>("sessions.create", {
    agentId: "ops",
    label: "Dashboard Chat",
    model: "openai/gpt-test-a",
    thinkingLevel: "high",
    fastMode: true,
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toMatch(/^agent:ops:dashboard:/);
  expect(created.payload?.entry?.label).toBe("Dashboard Chat");
  expect(created.payload?.entry?.providerOverride).toBe("openai");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-test-a");
  expect(created.payload?.entry?.thinkingLevel).toBe("high");
  expect(created.payload?.entry?.fastMode).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry).not.toHaveProperty("sessionFile");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "ops", sessionKey: key, storePath });
  expect(storedEntry?.sessionId).toBe(created.payload?.sessionId);
  expect(storedEntry?.label).toBe("Dashboard Chat");
  expect(storedEntry?.providerOverride).toBe("openai");
  expect(storedEntry?.modelOverride).toBe("gpt-test-a");
  expect(storedEntry?.thinkingLevel).toBe("high");
  expect(storedEntry?.fastMode).toBe(true);
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(storedEntry).not.toHaveProperty("sessionFile");

  await expect(
    loadTranscriptEvents({
      agentId: "ops",
      sessionId: requireNonEmptyString(created.payload?.sessionId, "created session id"),
      sessionKey: key,
      storePath,
    }),
  ).resolves.toEqual([
    expect.objectContaining({ id: created.payload?.sessionId, type: "session" }),
  ]);
});

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
    const registry = createEmptyPluginRegistry();
    if (harness === "cli") {
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

    try {
      const created = await directSessionReq<{
        entry?: {
          providerOverride?: string;
          modelOverride?: string;
          agentRuntimeOverride?: string;
          modelSelectionLocked?: boolean;
          pluginOwnerId?: string;
        };
        key?: string;
      }>("sessions.create", { agentId: "main", catalogId: "claude" });

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
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  },
);

test("sessions.create rejects a caller-supplied key for a catalog target", async () => {
  const { storePath } = await createSessionStoreDir();
  const existing = sessionStoreEntry("sess-existing-catalog-target", {
    providerOverride: "openai",
    modelOverride: "gpt-existing",
  });
  await writeSessionStore({ entries: { main: existing } });
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "anthropic",
    source: "test",
    provider: {
      id: "claude",
      label: "Claude Code",
      resolveCreateSession: () => ({
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
      }),
      list: vi.fn(async () => []),
      read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    },
  });
  setActivePluginRegistry(registry);

  try {
    const created = await directSessionReq("sessions.create", {
      key: "main",
      agentId: "main",
      catalogId: "claude",
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "sessions.create catalogId cannot include key",
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
    ).toMatchObject({
      sessionId: existing.sessionId,
      providerOverride: "openai",
      modelOverride: "gpt-existing",
    });
  } finally {
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
});

test("sessions.create authorizes a catalog target for the requested agent", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: "research" }],
  };
  const resolveCreateSession = vi.fn(({ agentId }: { agentId?: string }) =>
    agentId === "research"
      ? undefined
      : {
          model: "anthropic/claude-opus-4-8",
          agentRuntime: "claude-cli",
        },
  );
  const registry = createEmptyPluginRegistry();
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

  try {
    const created = await directSessionReq("sessions.create", {
      agentId: "research",
      catalogId: "claude",
    });

    expect(created.ok).toBe(false);
    expect(created.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "session catalog claude cannot create sessions",
    });
    expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "research" });
  } finally {
    testState.agentsConfig = undefined;
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
});

test("sessions.create bypasses main-session reset for a catalog target", async () => {
  await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "anthropic/claude-opus-4-8" } };
  testState.sessionConfig = { dmScope: "main" };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  ];
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent-catalog"),
    },
  });
  const registry = createEmptyPluginRegistry();
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
  registry.sessionCatalogs.push({
    pluginId: "anthropic",
    source: "test",
    provider: {
      id: "claude",
      label: "Claude Code",
      resolveCreateSession: () => ({
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
      }),
      list: vi.fn(async () => []),
      read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    },
  });
  setActivePluginRegistry(registry);

  try {
    const created = await directSessionReq<{
      key?: string;
      entry?: {
        parentSessionKey?: string;
        providerOverride?: string;
        modelOverride?: string;
        agentRuntimeOverride?: string;
        modelSelectionLocked?: boolean;
      };
    }>("sessions.create", {
      agentId: "main",
      catalogId: "claude",
      parentSessionKey: "main",
      emitCommandHooks: true,
    });

    expect(created.ok).toBe(true);
    expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
    expect(created.payload?.entry).toMatchObject({
      parentSessionKey: "agent:main:main",
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-8",
      agentRuntimeOverride: "claude-cli",
      modelSelectionLocked: true,
    });
  } finally {
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
});

test("sessions.create inherits explicit selection without runtime model identity", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent", {
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
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: {
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      agentRuntimeOverride?: string;
      modelProvider?: string;
      model?: string;
      contextTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      totalTokensFresh?: boolean;
      contextBudgetStatus?: unknown;
      thinkingLevel?: string;
      fastMode?: string;
      traceLevel?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      parentSessionKey?: string;
    };
  }>("sessions.create", {
    agentId: "main",
    label: "Fresh Chat",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.providerOverride).toBe("codex");
  expect(created.payload?.entry?.modelOverride).toBe("gpt-5.5");
  expect(created.payload?.entry?.modelOverrideSource).toBe("user");
  expect(created.payload?.entry?.agentRuntimeOverride).toBe("codex");
  expect(created.payload?.entry?.modelProvider).toBeUndefined();
  expect(created.payload?.entry?.model).toBeUndefined();
  expect(created.payload?.resolved).toEqual({ modelProvider: "codex", model: "gpt-5.5" });
  expect(created.payload?.entry?.contextTokens).toBeUndefined();
  expect(created.payload?.entry?.inputTokens).toBeUndefined();
  expect(created.payload?.entry?.outputTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokens).toBeUndefined();
  expect(created.payload?.entry?.totalTokensFresh).toBeUndefined();
  expect(created.payload?.entry?.contextBudgetStatus).toBeUndefined();
  expect(created.payload?.entry?.thinkingLevel).toBe("off");
  expect(created.payload?.entry?.fastMode).toBe("auto");
  expect(created.payload?.entry?.traceLevel).toBe("debug");
  expect(created.payload?.entry?.authProfileOverride).toBe("codex-oauth");
  expect(created.payload?.entry?.authProfileOverrideSource).toBe("user");

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.providerOverride).toBe("codex");
  expect(storedEntry?.modelOverride).toBe("gpt-5.5");
  expect(storedEntry?.modelProvider).toBeUndefined();
  expect(storedEntry?.model).toBeUndefined();
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");

  const overridden = await directSessionReq<{
    entry?: { fastMode?: boolean | "auto" };
  }>("sessions.create", {
    agentId: "main",
    fastMode: false,
    parentSessionKey: "main",
  });
  expect(overridden.ok, JSON.stringify(overridden.error)).toBe(true);
  expect(overridden.payload?.entry?.fastMode).toBe(false);
});

test("sessions.create skips inherited active auto fallback model overrides", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "openai/gpt-primary" } };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent-auto-fallback", {
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
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: {
      parentSessionKey?: string;
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      agentRuntimeOverride?: string;
      contextWindow?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      thinkingLevel?: string;
    };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.parentSessionKey).toBe("agent:main:main");
  expect(created.payload?.entry?.providerOverride).toBeUndefined();
  expect(created.payload?.entry?.modelOverride).toBeUndefined();
  expect(created.payload?.entry?.modelOverrideSource).toBeUndefined();
  expect(created.payload?.entry?.agentRuntimeOverride).toBeUndefined();
  expect(created.payload?.entry?.contextWindow).toBe("1m");
  expect(created.payload?.entry?.authProfileOverride).toBeUndefined();
  expect(created.payload?.entry?.authProfileOverrideSource).toBeUndefined();
  expect(created.payload?.entry?.thinkingLevel).toBe("high");
  expect(created.payload?.resolved).toEqual({ modelProvider: "openai", model: "gpt-primary" });

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.parentSessionKey).toBe("agent:main:main");
  expect(storedEntry?.providerOverride).toBeUndefined();
  expect(storedEntry?.modelOverride).toBeUndefined();
  expect(storedEntry?.agentRuntimeOverride).toBeUndefined();
  expect(storedEntry?.contextWindow).toBe("1m");
  expect(storedEntry?.authProfileOverride).toBeUndefined();
  expect(storedEntry?.authProfileOverrideSource).toBeUndefined();
  expect(storedEntry?.thinkingLevel).toBe("high");
});

test("sessions.create resolves the current default instead of inherited runtime identity", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { model: { primary: "anthropic/current-model" } };
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent-stale", {
        modelProvider: "openai",
        model: "stale-model",
      }),
    },
  });

  const created = await directSessionReq<{
    key?: string;
    resolved?: { modelProvider?: string; model?: string };
    entry?: { modelProvider?: string; model?: string };
  }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry?.modelProvider).toBeUndefined();
  expect(created.payload?.entry?.model).toBeUndefined();
  expect(created.payload?.resolved).toEqual({
    modelProvider: "anthropic",
    model: "current-model",
  });

  const key = created.payload?.key as string;
  const storedEntry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(storedEntry?.modelProvider).toBeUndefined();
  expect(storedEntry?.model).toBeUndefined();
});

test("sessions.create accepts an explicit key for persistent dashboard sessions", async () => {
  await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops-agent" }] };

  const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
  const created = await directSessionReq<{
    key?: string;
    sessionId?: string;
    entry?: {
      label?: string;
    };
  }>("sessions.create", {
    key,
    label: "Dashboard Orchestrator",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe(key);
  expect(created.payload?.entry?.label).toBe("Dashboard Orchestrator");
  expect(created.payload?.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("sessions.create preserves write-scoped fresh selection but gates adopted rows", async () => {
  const { storePath } = await createSessionStoreDir();
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "gpt-test-a", name: "A", provider: "openai" },
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

  const fresh = await directSessionReq<{
    entry?: { fastMode?: boolean; providerOverride?: string; modelOverride?: string };
  }>(
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

  const sameSelection = await directSessionReq<{
    entry?: {
      fastMode?: boolean;
      providerOverride?: string;
      modelOverride?: string;
      thinkingLevel?: string;
    };
  }>(
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

  const sameSubagentSelection = await directSessionReq<{
    entry?: { providerOverride?: string; modelOverride?: string };
  }>(
    "sessions.create",
    { key: existingSubagentKey, model: "openai/gpt-test-a" },
    { client: writeClient },
  );
  expect(sameSubagentSelection.ok, JSON.stringify(sameSubagentSelection.error)).toBe(true);
  expect(sameSubagentSelection.payload?.entry).toMatchObject({
    providerOverride: "openai",
    modelOverride: "gpt-test-a",
  });

  const sameSelectionWithProfile = await directSessionReq<{
    entry?: { providerOverride?: string; modelOverride?: string; authProfileOverride?: string };
  }>(
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

  const admin = await directSessionReq<{
    entry?: {
      fastMode?: boolean;
      providerOverride?: string;
      modelOverride?: string;
      thinkingLevel?: string;
    };
  }>(
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
});

test("sessions.create model change clears a selection the new model does not support", async () => {
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
  const adminClient = { connect: { scopes: ["operator.admin"] } } as never;
  const existingKey = "agent:main:dashboard:selected-window";
  await writeSessionStore({
    entries: {
      [existingKey]: sessionStoreEntry("sess-selected-window", {
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
        contextWindow: "200k",
      }),
    },
  });

  // Create-with-key adoption omits contextWindow, so the model change must take
  // the clearing branch for the now-unsupported selection instead of rejecting.
  const changed = await directSessionReq<{
    entry?: { modelOverride?: string; contextWindow?: string };
  }>("sessions.create", { key: existingKey, model: "openai/gpt-test-b" }, { client: adminClient });
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
  expect(changed.payload?.entry?.modelOverride).toBe("gpt-test-b");
  expect(changed.payload?.entry?.contextWindow).toBeUndefined();
  const stored = loadSessionEntry({ sessionKey: existingKey, storePath });
  expect(stored?.modelOverride).toBe("gpt-test-b");
  expect(stored?.contextWindow).toBeUndefined();
});
