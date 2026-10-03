import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
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
import { agentDiscoveryMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateTestHarness();

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

test("sessions.create persists model selection and parent linkage for a key-derived agent", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "ops-agent" }] };
  const key = "agent:ops-agent:dashboard:direct:subagent-orchestrator";
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-parent"),
    },
  });
  const created = await directSessionReq<CreatedSession>("sessions.create", {
    key,
    label: "Dashboard Chat",
    model: "openai/gpt-test-a",
    thinkingLevel: "high",
    fastMode: true,
    parentSessionKey: "main",
  });

  expect(created.ok).toBe(true);
  expect(created.payload?.key).toBe(key);
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

  const storedEntry = loadSessionEntry({ agentId: "ops-agent", sessionKey: key, storePath });
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
      agentId: "ops-agent",
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
    testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "research" }] };
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
  {
    name: "stale runtime identity",
    defaults: "anthropic/current-model",
    parent: { modelProvider: "openai", model: "stale-model" },
    inherited: {},
    absent: ["modelProvider", "model"],
    resolved: { modelProvider: "anthropic", model: "current-model" },
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
