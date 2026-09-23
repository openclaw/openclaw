/**
 * Gateway session reset model-selection tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../sessions/model-overrides.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsHandlerTestHarness,
  sessionStoreEntry,
  directSessionReq,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

type ModelResetEntry = Pick<
  SessionEntry,
  "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelProvider" | "model"
>;
type ResolvedSessionModel = { modelProvider: string; model: string };

test("sessions.reset stamps provenance when it materializes a missing row", async () => {
  await createSessionStoreDir();
  const reset = await directSessionReq<{ entry: SessionEntry }>(
    "sessions.reset",
    { key: "agent:main:subagent:missing" },
    {
      client: {
        authenticatedUserProfile: { profileId: "profile-reset-creator" },
      } as never,
    },
  );

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdActor: { type: "human", id: "profile-reset-creator" },
    createdAt: expect.any(Number),
  });
  expect(reset.payload?.entry).not.toHaveProperty("sandbox");
  expect(
    listSessionStateEventsSince("agent:main:subagent:missing", "main", 0, 20).events,
  ).toContainEqual(
    expect.objectContaining({
      kind: "created",
      actorType: "human",
      actorId: "profile-reset-creator",
    }),
  );
});

test("sessions.reset stamps the creator's required sandbox only when materializing a new row", async () => {
  const { storePath } = await createSessionStoreDir();
  const profile = ensureProfileForEmail("sandboxed-reset-creator@example.test");
  setUserProfileRole(profile.id, "guest");
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "none" },
            agents: ["main"],
            scopes: ["operator.read", "operator.write"],
            sandbox: "required",
          },
        },
      },
    },
  });

  try {
    const key = "agent:main:subagent:sandboxed-reset";
    const reset = await directSessionReq<{ entry: SessionEntry }>(
      "sessions.reset",
      { key },
      {
        client: {
          authenticatedUserProfile: { profileId: profile.id },
        } as never,
      },
    );

    expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
    expect(reset.payload?.entry).toMatchObject({
      createdActor: { type: "human", id: profile.id },
      sandbox: "required",
    });
    expect(loadSessionEntry({ sessionKey: key, storePath })?.sandbox).toBe("required");
  } finally {
    await writeConfigFile({});
  }
});

const ownedChildMetadata = {
  chatType: "group",
  delivery: normalizeSessionDeliveryState({
    context: {
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    },
    origin: { provider: "discord", chatType: "group" },
  }),
  groupId: "group-1",
  subject: "Ops Thread",
  groupChannel: "dev",
  space: "hq",
  spawnedBy: "agent:main:main",
  completionOwnerSessionKey: "agent:main:discord:direct:alice",
  inheritedToolPolicyVersion: 1,
  inheritedToolAllow: ["read", "message"],
  inheritedToolDeny: ["exec"],
  spawnedWorkspaceDir: "/tmp/child-workspace",
  spawnedCwd: "/tmp/task-repo",
  parentSessionKey: "agent:main:main",
  parentSessionId: "sess-parent",
  forkedFromParent: true,
  sandbox: "required",
  spawnDepth: 2,
  subagentRole: "orchestrator",
  subagentControlScope: "children",
  elevatedLevel: "on",
  ttsAuto: "always",
  providerOverride: "anthropic",
  modelOverride: "claude-opus-4-1",
  modelOverrideSource: "user",
  authProfileOverride: "work",
  authProfileOverrideSource: "user",
  authProfileOverrideCompactionCount: 7,
  sendPolicy: "deny",
  queueMode: "interrupt",
  queueDebounceMs: 250,
  queueCap: 9,
  queueDrop: "old",
  groupActivation: "always",
  groupActivationNeedsSystemIntro: true,
  execHost: "gateway",
  execNode: "mac-mini",
  displayName: "Ops Child",
  cliSessionIds: {
    "claude-cli": "cli-session-123",
  },
  cliSessionBindings: {
    "claude-cli": {
      sessionId: "cli-session-123",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
    },
  },
  claudeCliSessionId: "cli-session-123",
  label: "owned child",
  autoLabel: "Device",
} satisfies Partial<SessionEntry>;

function expectOwnedChildMetadata(entry: SessionEntry | undefined) {
  expect(entry).not.toHaveProperty("sessionFile");
  expect(entry).toMatchObject({
    ...ownedChildMetadata,
  });
}

async function expectMainResetModelFields(params: {
  defaultPrimary: string;
  sessionId: string;
  entry: Partial<SessionEntry>;
  expected: ModelResetEntry;
  expectedResolved: ResolvedSessionModel;
}) {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: params.defaultPrimary,
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(params.sessionId, params.entry),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: ModelResetEntry;
    resolved: ResolvedSessionModel;
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.resolved).toEqual(params.expectedResolved);
  const selectionKeys: Array<
    keyof Pick<ModelResetEntry, "providerOverride" | "modelOverride" | "modelOverrideSource">
  > = ["providerOverride", "modelOverride", "modelOverrideSource"];
  for (const key of selectionKeys) {
    expect(reset.payload?.entry?.[key]).toBe(params.expected[key]);
  }
  expect(reset.payload?.entry.modelProvider).toBe(params.expectedResolved.modelProvider);
  expect(reset.payload?.entry.model).toBe(params.expectedResolved.model);

  const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  for (const key of selectionKeys) {
    expect(stored?.[key]).toBe(params.expected[key]);
  }
  expect(stored?.modelProvider).toBeUndefined();
  expect(stored?.model).toBeUndefined();
}

test("sessions.reset rejects a model-locked session without replacing native state", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-model-locked", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: { threadId: "codex-thread-1" },
        },
      }),
    },
  });
  const before = loadSessionEntry({ sessionKey: "agent:main:main", storePath });

  const reset = await directSessionReq("sessions.reset", { key: "main" });

  expect(reset).toMatchObject({
    ok: false,
    error: { message: MODEL_SELECTION_LOCKED_RESET_MESSAGE },
  });
  const after = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(after).toEqual(before);
});

test("sessions.reset recomputes model from defaults instead of stale runtime model", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-model", {
        modelProvider: "qwencode",
        model: "qwen3.5-plus-2026-02-15",
        contextTokens: 123456,
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      sessionFile?: string;
      modelProvider?: string;
      model?: string;
      contextTokens?: number;
    };
    resolved: ResolvedSessionModel;
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).toBe("sess-stale-model");
  expect(reset.payload?.entry).not.toHaveProperty("sessionFile");
  expect(reset.payload?.resolved).toEqual({
    modelProvider: "openai",
    model: "gpt-test-a",
  });
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");
  expect(reset.payload?.entry.contextTokens).toBeUndefined();
});

test("sessions.reset retains sandbox choice but requires fresh native runtime consent", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sandbox-opt-out", {
        sandboxMode: "off",
        nativeRuntimeConsent: "native-fixture",
      }),
    },
  });
  const reset = await directSessionReq<{ entry: SessionEntry }>("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sandboxMode).toBe("off");
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.sandboxMode).toBe("off");
  expect(reset.payload?.entry.nativeRuntimeConsent).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).not.toHaveProperty(
    "nativeRuntimeConsent",
  );
});
test("sessions.reset preserves the selected runtime and retires native conversation bindings", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "old conversation");
  await writeSessionStore({
    entries: {
      main: {
        ...sessionStoreEntry("sess-main"),
        lifecycleRevision: "old-lifecycle",
        providerOverride: "provider-a",
        modelOverride: "opaque/model",
        modelOverrideSource: "user",
        agentRuntimeOverride: "native-runtime",
        agentHarnessId: "previous-runtime",
        cliSessionIds: { "previous-runtime": "old-native-session" },
      },
    },
  });
  const response = await directSessionReq("sessions.reset", { key: "main" });
  expect(response.ok).toBe(true);
  const entry = loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath });
  expect(entry).toMatchObject({
    sessionId: "sess-main",
    providerOverride: "provider-a",
    modelOverride: "opaque/model",
    modelOverrideSource: "user",
    agentRuntimeOverride: "native-runtime",
  });
  expect(entry?.lifecycleRevision).not.toBe("old-lifecycle");
  expect(entry?.agentHarnessId).toBeUndefined();
  expect(entry?.cliSessionIds).toBeUndefined();
});

test("sessions.reset clears stale estimated context budget status", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-budget", {
        totalTokens: 0,
        totalTokensFresh: false,
        contextTokens: 123456,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "qwencode",
          model: "qwen3.5-plus-2026-02-15",
          route: "compact_then_truncate",
          shouldCompact: true,
          estimatedPromptTokens: 120_000,
          contextTokenBudget: 80_000,
          promptBudgetBeforeReserve: 70_000,
          reserveTokens: 10_000,
          effectiveReserveTokens: 10_000,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 50_000,
          toolResultReducibleChars: 0,
          messageCount: 10,
          unwindowedMessageCount: 10,
          sessionId: "sess-stale-budget",
        },
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    entry: {
      sessionId: string;
      contextBudgetStatus?: unknown;
      contextTokens?: number;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe("sess-stale-budget");
  expect(reset.payload?.entry.contextBudgetStatus).toBeUndefined();
  expect(reset.payload?.entry.contextTokens).toBeUndefined();

  const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(stored?.contextBudgetStatus).toBeUndefined();
  expect(stored?.contextTokens).toBeUndefined();
});

test("sessions.reset drops cached skills snapshot so /new rebuilds visible skills", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-skills", {
        skillsSnapshot: {
          prompt: "<available_skills><skill><name>stale</name></skill></available_skills>",
          skills: [{ name: "stale" }],
          version: 0,
        },
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      skillsSnapshot?: unknown;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe("sess-stale-skills");
  expect(reset.payload?.entry.skillsSnapshot).toBeUndefined();

  const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(stored?.skillsSnapshot).toBeUndefined();
});

test.each([
  {
    locator: "a generated topic",
    key: "agent:main:telegram:group:123:topic:456",
    sessionKey: "agent:main:telegram:group:123:topic:456",
    sessionId: "11111111-1111-4111-8111-111111111111",
    filename: "11111111-1111-4111-8111-111111111111-topic-456.jsonl",
  },
  {
    locator: "an already-stale generated",
    key: "main",
    sessionKey: "agent:main:main",
    sessionId: "22222222-2222-4222-8222-222222222222",
    // Upgraded stores can retain a locator for an older session ID (#77770).
    filename: "11111111-1111-4111-8111-111111111111.jsonl",
  },
])(
  "sessions.reset drops $locator transcript locator",
  async ({ key, sessionKey, sessionId, filename }) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionFile = path.join(dir, filename);
    await fs.writeFile(sessionFile, `${JSON.stringify({ role: "user", content: "old" })}\n`);

    await writeSessionStore({
      entries: {
        [key]: sessionStoreEntry(sessionId, { sessionFile }),
      },
    });

    const reset = await directSessionReq<{ entry: SessionEntry }>("sessions.reset", { key });

    expect(reset.ok).toBe(true);
    expect(reset.payload?.entry.sessionId).toBe(sessionId);
    expect(reset.payload?.entry).not.toHaveProperty("sessionFile");

    const persistedEntry = loadSessionEntry({ sessionKey, storePath });
    expect(persistedEntry?.sessionId).toBe(sessionId);
    expect(persistedEntry).not.toHaveProperty("sessionFile");
  },
);

test("sessions.reset drops a stale SQLite marker", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "current-session";
  const sessionKey = "agent:main:main";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId),
    },
  });
  const current = loadSessionEntry({ sessionKey, storePath });
  if (!current) {
    throw new Error("expected current session entry");
  }
  const staleMarker = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId: "stale-session",
    storePath,
  });
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      ...current,
      sessionFile: staleMarker,
    },
  );

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: { sessionId: string; sessionFile?: string };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe(sessionId);
  expect(reset.payload?.entry).not.toHaveProperty("sessionFile");
});

test("sessions.reset preserves legacy explicit model overrides without modelOverrideSource", async () => {
  await expectMainResetModelFields({
    defaultPrimary: "openai/gpt-test-a",
    sessionId: "sess-explicit-model-override",
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelProvider: "openai",
      model: "gpt-test-a",
    },
    expected: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelOverrideSource: "user",
    },
    expectedResolved: { modelProvider: "anthropic", model: "claude-opus-4-1" },
  });
});

test("sessions.reset clears fallback-pinned model overrides and restores the selected model", async () => {
  await expectMainResetModelFields({
    defaultPrimary: "openai/gpt-test-a",
    sessionId: "sess-fallback-model-override",
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelOverrideSource: "auto",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-test-a",
        activeModel: "anthropic/claude-opus-4-1",
        reason: "rate limit",
      },
    },
    expected: {
      providerOverride: undefined,
      modelOverride: undefined,
    },
    expectedResolved: { modelProvider: "openai", model: "gpt-test-a" },
  });
});

test("sessions.reset follows the updated default after an auto fallback pinned an older default", async () => {
  await expectMainResetModelFields({
    defaultPrimary: "openai/gpt-test-c",
    sessionId: "sess-fallback-stale-default",
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelOverrideSource: "auto",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-test-a",
        activeModel: "anthropic/claude-opus-4-1",
        reason: "rate limit",
      },
    },
    expected: {
      providerOverride: undefined,
      modelOverride: undefined,
    },
    expectedResolved: { modelProvider: "openai", model: "gpt-test-c" },
  });
});

test("sessions.reset preserves spawned session ownership metadata", async () => {
  const { storePath } = await createSessionStoreDir();
  const customSessionFile = path.join(
    await fs.realpath(path.dirname(storePath)),
    "custom-owned-child-transcript.jsonl",
  );
  await writeSessionStore({
    entries: {
      "subagent:child": sessionStoreEntry("sess-owned-child", {
        sessionFile: customSessionFile,
        ...ownedChildMetadata,
        forkedFromParent: undefined,
        createdVia: "spawn",
        createdActor: { type: "agent", id: "agent:main:main" },
        createdAt: 1_000,
        forkSource: {
          sessionKey: "agent:main:root",
          sessionId: "root-session",
          entryId: "root-entry",
        },
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: SessionEntry;
  }>("sessions.reset", { key: "subagent:child" });

  expect(reset.ok).toBe(true);
  expectOwnedChildMetadata(reset.payload?.entry);
  expect(reset.payload?.entry).toMatchObject({
    createdVia: "spawn",
    createdActor: { type: "agent", id: "agent:main:main" },
    createdAt: 1_000,
    forkSource: {
      sessionKey: "agent:main:root",
      sessionId: "root-session",
      entryId: "root-entry",
    },
  });

  const stored = loadSessionEntry({ sessionKey: "agent:main:subagent:child", storePath });
  expectOwnedChildMetadata(stored);
  expect(stored).toMatchObject({
    createdVia: "spawn",
    createdActor: { type: "agent", id: "agent:main:main" },
    createdAt: 1_000,
    forkSource: {
      sessionKey: "agent:main:root",
      sessionId: "root-session",
      entryId: "root-entry",
    },
  });
});
