import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { getSessionEntry } from "../config/sessions.js";
import { hasSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { testState, seedGatewaySessionEntries } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

test("sessions.reset recomputes model from defaults instead of stale runtime model", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await seedGatewaySessionEntries({
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
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-stale-model");
  const sessionFile = reset.payload?.entry.sessionFile;
  if (!sessionFile) {
    throw new Error("expected reset session file");
  }
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");
  expect(reset.payload?.entry.contextTokens).toBeUndefined();
  expect(
    hasSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: reset.payload?.entry.sessionId ?? "",
    }),
  ).toBe(true);
});

test("sessions.reset drops cached skills snapshot so /new rebuilds visible skills", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await seedGatewaySessionEntries({
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
  expect(reset.payload?.entry.sessionId).not.toBe("sess-stale-skills");
  expect(reset.payload?.entry.skillsSnapshot).toBeUndefined();

  expect(
    getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })?.skillsSnapshot,
  ).toBeUndefined();
});

test("sessions.reset preserves legacy explicit model overrides without modelOverrideSource", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-explicit-model-override", {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
        modelProvider: "openai",
        model: "gpt-test-a",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      providerOverride?: string;
      modelOverride?: string;
      modelOverrideSource?: string;
      modelProvider?: string;
      model?: string;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.providerOverride).toBe("anthropic");
  expect(reset.payload?.entry.modelOverride).toBe("claude-opus-4-1");
  expect(reset.payload?.entry.modelOverrideSource).toBe("user");
  expect(reset.payload?.entry.modelProvider).toBe("anthropic");
  expect(reset.payload?.entry.model).toBe("claude-opus-4-1");

  const stored = getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  expect(stored?.providerOverride).toBe("anthropic");
  expect(stored?.modelOverride).toBe("claude-opus-4-1");
  expect(stored?.modelOverrideSource).toBe("user");
  expect(stored?.modelProvider).toBe("anthropic");
  expect(stored?.model).toBe("claude-opus-4-1");
});

test("sessions.reset clears fallback-pinned model overrides and restores the selected model", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-fallback-model-override", {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
        modelOverrideSource: "auto",
        fallbackNoticeSelectedModel: "openai/gpt-test-a",
        fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
        fallbackNoticeReason: "rate limit",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      providerOverride?: string;
      modelOverride?: string;
      modelProvider?: string;
      model?: string;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.providerOverride).toBeUndefined();
  expect(reset.payload?.entry.modelOverride).toBeUndefined();
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");

  const stored = getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  expect(stored?.providerOverride).toBeUndefined();
  expect(stored?.modelOverride).toBeUndefined();
  expect(stored?.modelProvider).toBe("openai");
  expect(stored?.model).toBe("gpt-test-a");
});

test("sessions.reset follows the updated default after an auto fallback pinned an older default", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-c",
    },
  };

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-fallback-stale-default", {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-1",
        modelOverrideSource: "auto",
        fallbackNoticeSelectedModel: "openai/gpt-test-a",
        fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
        fallbackNoticeReason: "rate limit",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      providerOverride?: string;
      modelOverride?: string;
      modelProvider?: string;
      model?: string;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.providerOverride).toBeUndefined();
  expect(reset.payload?.entry.modelOverride).toBeUndefined();
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-c");

  const stored = getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  expect(stored?.providerOverride).toBeUndefined();
  expect(stored?.modelOverride).toBeUndefined();
  expect(stored?.modelProvider).toBe("openai");
  expect(stored?.model).toBe("gpt-test-c");
});

test("sessions.reset preserves spawned session ownership metadata", async () => {
  const { dir } = await createSessionStoreDir();
  const stateDir = await fs.realpath(process.env.OPENCLAW_STATE_DIR ?? dir);
  const customSessionFile = path.join(
    stateDir,
    "agents",
    "main",
    "sessions",
    "custom-owned-child-transcript.jsonl",
  );
  await seedGatewaySessionEntries({
    entries: {
      "subagent:child": sessionStoreEntry("sess-owned-child", {
        sessionFile: customSessionFile,
        chatType: "group",
        channel: "discord",
        groupId: "group-1",
        subject: "Ops Thread",
        groupChannel: "dev",
        space: "hq",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/child-workspace",
        parentSessionKey: "agent:main:main",
        forkedFromParent: true,
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
        execSecurity: "allowlist",
        execAsk: "on-miss",
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
        deliveryContext: {
          channel: "discord",
          to: "discord:child",
          accountId: "acct-1",
          threadId: "thread-1",
        },
        label: "owned child",
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionFile?: string;
      chatType?: string;
      channel?: string;
      groupId?: string;
      subject?: string;
      groupChannel?: string;
      space?: string;
      spawnedBy?: string;
      spawnedWorkspaceDir?: string;
      parentSessionKey?: string;
      forkedFromParent?: boolean;
      spawnDepth?: number;
      subagentRole?: string;
      subagentControlScope?: string;
      elevatedLevel?: string;
      ttsAuto?: string;
      providerOverride?: string;
      modelOverride?: string;
      authProfileOverride?: string;
      authProfileOverrideSource?: string;
      authProfileOverrideCompactionCount?: number;
      sendPolicy?: string;
      queueMode?: string;
      queueDebounceMs?: number;
      queueCap?: number;
      queueDrop?: string;
      groupActivation?: string;
      groupActivationNeedsSystemIntro?: boolean;
      execHost?: string;
      execSecurity?: string;
      execAsk?: string;
      execNode?: string;
      displayName?: string;
      cliSessionBindings?: Record<
        string,
        {
          sessionId?: string;
          authProfileId?: string;
          extraSystemPromptHash?: string;
          mcpConfigHash?: string;
        }
      >;
      cliSessionIds?: Record<string, string>;
      claudeCliSessionId?: string;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string;
      };
      label?: string;
    };
  }>("sessions.reset", { key: "subagent:child" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionFile).toBe(customSessionFile);
  expect(reset.payload?.entry.chatType).toBe("group");
  expect(reset.payload?.entry.channel).toBe("discord");
  expect(reset.payload?.entry.groupId).toBe("group-1");
  expect(reset.payload?.entry.subject).toBe("Ops Thread");
  expect(reset.payload?.entry.groupChannel).toBe("dev");
  expect(reset.payload?.entry.space).toBe("hq");
  expect(reset.payload?.entry.spawnedBy).toBe("agent:main:main");
  expect(reset.payload?.entry.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
  expect(reset.payload?.entry.parentSessionKey).toBe("agent:main:main");
  expect(reset.payload?.entry.forkedFromParent).toBe(true);
  expect(reset.payload?.entry.spawnDepth).toBe(2);
  expect(reset.payload?.entry.subagentRole).toBe("orchestrator");
  expect(reset.payload?.entry.subagentControlScope).toBe("children");
  expect(reset.payload?.entry.elevatedLevel).toBe("on");
  expect(reset.payload?.entry.ttsAuto).toBe("always");
  expect(reset.payload?.entry.providerOverride).toBe("anthropic");
  expect(reset.payload?.entry.modelOverride).toBe("claude-opus-4-1");
  expect(reset.payload?.entry.authProfileOverride).toBe("work");
  expect(reset.payload?.entry.authProfileOverrideSource).toBe("user");
  expect(reset.payload?.entry.authProfileOverrideCompactionCount).toBe(7);
  expect(reset.payload?.entry.sendPolicy).toBe("deny");
  expect(reset.payload?.entry.queueMode).toBe("interrupt");
  expect(reset.payload?.entry.queueDebounceMs).toBe(250);
  expect(reset.payload?.entry.queueCap).toBe(9);
  expect(reset.payload?.entry.queueDrop).toBe("old");
  expect(reset.payload?.entry.groupActivation).toBe("always");
  expect(reset.payload?.entry.groupActivationNeedsSystemIntro).toBe(true);
  expect(reset.payload?.entry.execHost).toBe("gateway");
  expect(reset.payload?.entry.execSecurity).toBe("allowlist");
  expect(reset.payload?.entry.execAsk).toBe("on-miss");
  expect(reset.payload?.entry.execNode).toBe("mac-mini");
  expect(reset.payload?.entry.displayName).toBe("Ops Child");
  expect(reset.payload?.entry.cliSessionBindings).toEqual({
    "claude-cli": {
      sessionId: "cli-session-123",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
    },
  });
  expect(reset.payload?.entry.cliSessionIds).toEqual({
    "claude-cli": "cli-session-123",
  });
  expect(reset.payload?.entry.claudeCliSessionId).toBe("cli-session-123");
  expect(reset.payload?.entry.deliveryContext).toEqual({
    channel: "discord",
    to: "discord:child",
    accountId: "acct-1",
    threadId: "thread-1",
  });
  expect(reset.payload?.entry.label).toBe("owned child");

  const stored = getSessionEntry({ agentId: "main", sessionKey: "agent:main:subagent:child" });
  expect(stored?.sessionFile).toBe(customSessionFile);
  expect(stored?.chatType).toBe("group");
  expect(stored?.channel).toBe("discord");
  expect(stored?.groupId).toBe("group-1");
  expect(stored?.subject).toBe("Ops Thread");
  expect(stored?.groupChannel).toBe("dev");
  expect(stored?.space).toBe("hq");
  expect(stored?.spawnedBy).toBe("agent:main:main");
  expect(stored?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
  expect(stored?.parentSessionKey).toBe("agent:main:main");
  expect(stored?.forkedFromParent).toBe(true);
  expect(stored?.spawnDepth).toBe(2);
  expect(stored?.subagentRole).toBe("orchestrator");
  expect(stored?.subagentControlScope).toBe("children");
  expect(stored?.elevatedLevel).toBe("on");
  expect(stored?.ttsAuto).toBe("always");
  expect(stored?.providerOverride).toBe("anthropic");
  expect(stored?.modelOverride).toBe("claude-opus-4-1");
  expect(stored?.authProfileOverride).toBe("work");
  expect(stored?.authProfileOverrideSource).toBe("user");
  expect(stored?.authProfileOverrideCompactionCount).toBe(7);
  expect(stored?.sendPolicy).toBe("deny");
  expect(stored?.queueMode).toBe("interrupt");
  expect(stored?.queueDebounceMs).toBe(250);
  expect(stored?.queueCap).toBe(9);
  expect(stored?.queueDrop).toBe("old");
  expect(stored?.groupActivation).toBe("always");
  expect(stored?.groupActivationNeedsSystemIntro).toBe(true);
  expect(stored?.execHost).toBe("gateway");
  expect(stored?.execSecurity).toBe("allowlist");
  expect(stored?.execAsk).toBe("on-miss");
  expect(stored?.execNode).toBe("mac-mini");
  expect(stored?.displayName).toBe("Ops Child");
  expect(stored?.cliSessionBindings).toEqual({
    "claude-cli": {
      sessionId: "cli-session-123",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
    },
  });
  expect(stored?.cliSessionIds).toEqual({
    "claude-cli": "cli-session-123",
  });
  expect(stored?.claudeCliSessionId).toBe("cli-session-123");
  expect(stored?.deliveryContext).toEqual({
    channel: "discord",
    to: "discord:child",
    accountId: "acct-1",
    threadId: "thread-1",
  });
  expect(stored?.label).toBe("owned child");
});
