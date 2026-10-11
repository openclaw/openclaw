/**
 * Gateway session reset model-selection tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../sessions/model-overrides.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createSessionMutationTestClient } from "./server-methods/sessions-mutations.owner.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsHandlerTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

type ModelResetEntry = Pick<
  SessionEntry,
  "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelProvider" | "model"
>;
type ResolvedSessionModel = { modelProvider: string; model: string };

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
        client: createSessionMutationTestClient(profile.id),
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
        inheritedGitContributorProfileIds: ["original-contributor"],
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
  expect(reset.payload?.entry).not.toHaveProperty("inheritedGitContributorProfileIds");
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
    inheritedGitContributorProfileIds: ["original-contributor"],
    forkSource: {
      sessionKey: "agent:main:root",
      sessionId: "root-session",
      entryId: "root-entry",
    },
  });
});
