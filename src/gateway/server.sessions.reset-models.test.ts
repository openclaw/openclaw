import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../sessions/model-overrides.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
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

async function seedMain(sessionId: string, entry: Partial<SessionEntry>, primary?: string) {
  const { storePath } = await createSessionStoreDir();
  if (primary) {
    testState.agentConfig = { model: { primary } };
  }
  await writeSessionStore({ entries: { main: sessionStoreEntry(sessionId, entry) } });
  return () => loadSessionEntry({ sessionKey: "agent:main:main", storePath });
}

const resetMain = () =>
  directSessionReq<{ entry: SessionEntry }>("sessions.reset", { key: "main" });

test("sessions.reset preserves a person-linked model account", async () => {
  const selection = {
    authProfileOverride: "openai:linked-person",
    authProfileOverrideSource: "user-link",
  } satisfies Partial<SessionEntry>;
  const read = await seedMain("linked-account", selection);
  const reset = await resetMain();
  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject(selection);
  expect(read()).toMatchObject(selection);
});

test("sessions.reset stamps the creator's required sandbox only when materializing a new row", async () => {
  const { storePath } = await createSessionStoreDir();
  const profile = ensureProfileForEmail("sandboxed-reset-creator@example.test");
  setUserProfileRole(profile.id, "guest");
  using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
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
  sidebarRoot: true,
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
  communication: { send: "never", receive: "ask" },
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
      reseedReceipt: {
        version: 1,
        promptHash: "a".repeat(64),
        localSessionId: "sess-owned-child",
        userTurnDisposition: "omitted",
      },
    },
  },
  claudeCliSessionId: "cli-session-123",
  label: "owned child",
  autoLabel: "Device",
} satisfies Partial<SessionEntry>;

test("sessions.reset rejects a model-locked session without replacing native state", async () => {
  const read = await seedMain("sess-model-locked", {
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: { codex: { threadId: "codex-thread-1" } },
  });
  const before = read();
  expect(await resetMain()).toMatchObject({
    ok: false,
    error: { message: MODEL_SELECTION_LOCKED_RESET_MESSAGE },
  });
  expect(read()).toEqual(before);
});

test("sessions.reset retains sandbox choice but requires fresh native runtime consent", async () => {
  const read = await seedMain("sandbox-opt-out", {
    sandboxMode: "off",
    nativeRuntimeConsent: "native-fixture",
  });
  const reset = await resetMain();
  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject({ sandboxMode: "off" });
  expect(reset.payload?.entry.nativeRuntimeConsent).toBeUndefined();
  expect(read()).toMatchObject({ sandboxMode: "off" });
  expect(read()).not.toHaveProperty("nativeRuntimeConsent");
});

test("sessions.reset drops cached skills snapshot so /new rebuilds visible skills", async () => {
  const read = await seedMain(
    "sess-stale-skills",
    {
      skillsSnapshot: {
        prompt: "<available_skills><skill><name>stale</name></skill></available_skills>",
        skills: [{ name: "stale" }],
        version: 0,
      },
    },
    "openai/gpt-test-a",
  );
  const reset = await resetMain();
  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe("sess-stale-skills");
  expect(reset.payload?.entry.skillsSnapshot).toBeUndefined();

  expect(read()?.skillsSnapshot).toBeUndefined();
});

test("sessions.reset follows the updated default after an auto fallback pinned an older default", async () => {
  const read = await seedMain(
    "sess-fallback-stale-default",
    {
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
    "openai/gpt-test-c",
  );
  const resolved = { modelProvider: "openai", model: "gpt-test-c" };
  const reset = await directSessionReq<{ entry: SessionEntry; resolved: typeof resolved }>(
    "sessions.reset",
    { key: "main" },
  );
  expect(reset).toMatchObject({ ok: true, payload: { entry: resolved } });
  expect(reset.payload?.resolved).toEqual(resolved);
  const stored = read();
  for (const entry of [reset.payload?.entry, stored]) {
    for (const key of ["providerOverride", "modelOverride", "modelOverrideSource"] as const) {
      expect(entry?.[key]).toBeUndefined();
    }
  }
  expect(stored?.modelProvider).toBeUndefined();
  expect(stored?.model).toBeUndefined();
});

test("sessions.reset preserves spawned session ownership metadata", async () => {
  const { storePath } = await createSessionStoreDir();
  const customSessionFile = path.join(
    await fs.realpath(path.dirname(storePath)),
    "custom-owned-child-transcript.jsonl",
  );
  const provenance = {
    createdVia: "spawn",
    createdActor: { type: "agent", id: "agent:main:main" },
    createdAt: 1_000,
    forkSource: {
      sessionKey: "agent:main:root",
      sessionId: "root-session",
      entryId: "root-entry",
    },
  } satisfies Partial<SessionEntry>;
  await writeSessionStore({
    entries: {
      "subagent:child": sessionStoreEntry("sess-owned-child", {
        agentHarnessId: "codex",
        sessionFile: customSessionFile,
        ...ownedChildMetadata,
        forkedFromParent: undefined,
        ...provenance,
        inheritedGitContributorProfileIds: ["original-contributor"],
      }),
    },
  });

  const reset = await directSessionReq<{ entry: SessionEntry }>("sessions.reset", {
    key: "subagent:child",
  });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).not.toHaveProperty("inheritedGitContributorProfileIds");
  const stored = loadSessionEntry({ sessionKey: "agent:main:subagent:child", storePath });
  for (const entry of [reset.payload?.entry, stored]) {
    expect(entry).not.toHaveProperty("sessionFile");
    expect(entry).not.toHaveProperty("agentHarnessId");
    expect(entry).toMatchObject({
      sessionId: "sess-owned-child",
      ...ownedChildMetadata,
      ...provenance,
    });
    // Spawned children retain CLI bindings and reseed receipts (fa56682b3ced).
    expect(entry?.cliSessionIds).toEqual(ownedChildMetadata.cliSessionIds);
    expect(entry?.cliSessionBindings).toEqual(ownedChildMetadata.cliSessionBindings);
  }
  expect(stored?.inheritedGitContributorProfileIds).toEqual(["original-contributor"]);
});
