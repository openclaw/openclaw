import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as bootstrapCache from "../../agents/bootstrap-cache.js";
import {
  __testing as sessionMcpTesting,
  getOrCreateSessionMcpRuntime,
} from "../../agents/pi-bundle-mcp-tools.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  deleteSessionEntry,
  listSessionEntries,
  upsertSessionEntry,
} from "../../config/sessions/store.js";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
  registerSessionBindingAdapter,
} from "../../infra/outbound/session-binding-service.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { drainFormattedSystemEvents } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { initSessionState } from "./session.js";

const sessionForkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(),
  resolveParentForkTokenCount: vi.fn(),
  nextSessionId: 0,
}));
const channelSummaryMocks = vi.hoisted(() => ({
  buildChannelSummary: vi.fn(async () => [] as string[]),
}));
const browserMaintenanceMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

type ForkSessionParamsForTest = {
  parentEntry: SessionEntry;
  agentId: string;
};

vi.mock("./session-fork.js", () => ({
  forkSessionFromParent: (...args: [ForkSessionParamsForTest]) =>
    sessionForkMocks.forkSessionFromParent(...args),
  resolveParentForkTokenCount: (...args: [{ parentEntry: SessionEntry; agentId: string }]) =>
    sessionForkMocks.resolveParentForkTokenCount(...args),
  resolveParentForkDecision: async (params: { parentEntry: SessionEntry; agentId: string }) => {
    const maxTokens = 100_000;
    const parentTokens = await sessionForkMocks.resolveParentForkTokenCount({
      parentEntry: params.parentEntry,
      agentId: params.agentId,
    });
    if (typeof parentTokens === "number" && parentTokens > maxTokens) {
      return {
        status: "skip",
        reason: "parent-too-large",
        maxTokens,
        parentTokens,
        message: `Parent context is too large to fork (${parentTokens}/${maxTokens} tokens); starting with isolated context instead.`,
      };
    }
    return {
      status: "fork",
      maxTokens,
      ...(typeof parentTokens === "number" ? { parentTokens } : {}),
    };
  },
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

vi.mock("../../infra/channel-summary.js", () => ({
  buildChannelSummary: channelSummaryMocks.buildChannelSummary,
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.7", name: "M2.7" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeCaseDir(prefix: string): Promise<string> {
  const stateDir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

type TestSessionRowsTarget = {
  agentId: string;
  sessionsDir: string;
};

function createSessionRowsTargetFromSessionsDir(
  sessionsDir: string,
  agentId = "main",
): TestSessionRowsTarget {
  return { agentId, sessionsDir };
}

async function makeSessionRowsTarget(prefix: string): Promise<TestSessionRowsTarget> {
  const sessionsDir = await makeCaseDir(prefix);
  const target = createSessionRowsTargetFromSessionsDir(sessionsDir);
  currentTestSessionRowsTarget = target;
  return target;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

const createSessionRowsTarget = makeSessionRowsTarget;
const TEST_NATIVE_MODEL_PROFILE_ID = "openai-codex:secondary@example.test";
let currentTestSessionRowsTarget: TestSessionRowsTarget | undefined;

function getCurrentTestSessionRowsTarget(): TestSessionRowsTarget {
  if (!currentTestSessionRowsTarget) {
    throw new Error("Expected current session rows target to be initialized");
  }
  return currentTestSessionRowsTarget;
}

async function replaceSessionRowsForFixtureTarget(
  target: TestSessionRowsTarget,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  const { agentId } = target;
  for (const { sessionKey } of listSessionEntries({ agentId })) {
    deleteSessionEntry({ agentId, sessionKey });
  }
  for (const [sessionKey, entry] of Object.entries(store)) {
    upsertSessionEntry({ agentId, sessionKey, entry: entry as SessionEntry });
  }
}

function readSessionRowsForFixtureTarget(
  target: TestSessionRowsTarget,
): Record<string, SessionEntry> {
  const { agentId } = target;
  return Object.fromEntries(
    listSessionEntries({ agentId }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function setMinimalCurrentConversationBindingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "signal",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "signal", label: "Signal" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^signal:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "googlechat",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "googlechat", label: "Google Chat" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^googlechat:/i, ""))
                .map((candidate) => candidate?.replace(/^spaces:/i, "spaces/"))
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
    ]),
  );
}

function registerCurrentConversationBindingAdapterForTest(params: {
  channel: "slack" | "signal" | "googlechat";
  accountId: string;
}): void {
  const bindings: Array<{
    bindingId: string;
    targetSessionKey: string;
    targetKind: "session" | "subagent";
    conversation: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };
    status: "active";
    boundAt: number;
    metadata?: Record<string, unknown>;
  }> = [];
  registerSessionBindingAdapter({
    channel: params.channel,
    accountId: params.accountId,
    capabilities: { placements: ["current"] },
    bind: async (input) => {
      const record = {
        bindingId: `${input.conversation.channel}:${input.conversation.accountId}:${input.conversation.conversationId}`,
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation: input.conversation,
        status: "active" as const,
        boundAt: Date.now(),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      bindings.push(record);
      return record;
    },
    listBySession: (targetSessionKey) =>
      bindings.filter((binding) => binding.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (binding) =>
          binding.conversation.channel === ref.channel &&
          binding.conversation.accountId === ref.accountId &&
          binding.conversation.conversationId === ref.conversationId,
      ) ?? null,
  });
}

beforeEach(() => {
  channelSummaryMocks.buildChannelSummary.mockReset().mockResolvedValue([]);
  browserMaintenanceMocks.closeTrackedBrowserTabsForSessions.mockReset().mockResolvedValue(0);
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  sessionForkMocks.nextSessionId = 0;
  sessionForkMocks.resolveParentForkTokenCount.mockReset().mockImplementation(({ parentEntry }) => {
    const tokens = parentEntry.totalTokens;
    return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
      ? Math.floor(tokens)
      : undefined;
  });
  sessionForkMocks.forkSessionFromParent
    .mockReset()
    .mockImplementation(async ({ parentEntry, agentId }: ForkSessionParamsForTest) => {
      if (!parentEntry.sessionFile) {
        return null;
      }
      const sessionsDir = path.dirname(parentEntry.sessionFile);
      const sessionId = `forked-session-${++sessionForkMocks.nextSessionId}`;
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      replaceSqliteSessionTranscriptEvents({
        agentId,
        sessionId,
        transcriptPath: sessionFile,
        events: [
          {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: process.cwd(),
            parentSession: parentEntry.sessionFile,
          },
        ],
      });
      return { sessionId, sessionFile: path.resolve(sessionFile) };
    });
});
afterEach(async () => {
  resetSystemEventsForTest();
  await sessionMcpTesting.resetSessionMcpRuntimeManager();
});
describe("initSessionState thread forking", () => {
  it("forks a new session from the parent session file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    const assistantMessage = {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Parent reply" },
    };
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: parentSessionId,
      transcriptPath: parentSessionFile,
      events: [header, message, assistantMessage],
    });

    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const parentSessionKey = "agent:main:slack:channel:c1";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: {},
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    const threadLabel = "Slack thread #general: starter";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        ThreadLabel: threadLabel,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(threadSessionKey);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.displayName).toBe(threadLabel);

    const [headerEvent] = loadSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: result.sessionEntry.sessionId,
    });
    if (!headerEvent) {
      throw new Error("Missing session header");
    }
    const parsedHeader = headerEvent.event as {
      parentSession?: string;
    };
    const expectedParentSession = path.resolve(parentSessionFile);
    const actualParentSession = parsedHeader.parentSession
      ? path.resolve(parsedHeader.parentSession)
      : undefined;
    expect(actualParentSession).toBe(expectedParentSession);
    warn.mockRestore();
  });

  it("forks from parent when thread session key already exists but was not forked yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-existing-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    const assistantMessage = {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Parent reply" },
    };
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: parentSessionId,
      transcriptPath: parentSessionFile,
      events: [header, message, assistantMessage],
    });

    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      [threadSessionKey]: {
        sessionId: "preseed-thread-session",
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: {},
    } as OpenClawConfig;

    const first = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(first.sessionEntry.sessionId).not.toBe("preseed-thread-session");
    expect(first.sessionEntry.forkedFromParent).toBe(true);

    const second = await initSessionState({
      ctx: {
        Body: "Thread reply 2",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(second.sessionEntry.sessionId).toBe(first.sessionEntry.sessionId);
    expect(second.sessionEntry.forkedFromParent).toBe(true);
    warn.mockRestore();
  });

  it("skips fork and creates fresh session when parent tokens exceed threshold", async () => {
    const root = await makeCaseDir("openclaw-thread-session-overflow-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-overflow";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    const assistantMessage = {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Parent reply" },
    };
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: parentSessionId,
      transcriptPath: parentSessionFile,
      events: [header, message, assistantMessage],
    });

    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const parentSessionKey = "agent:main:slack:channel:c1";
    // Set totalTokens well above PARENT_FORK_MAX_TOKENS (100_000)
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
        totalTokens: 170_000,
      },
    });

    const cfg = {
      session: {},
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:456";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    // Should be marked as forked (to prevent re-attempts) but NOT actually forked from parent
    expect(result.sessionEntry.forkedFromParent).toBe(true);
    // Session ID should NOT match the parent — it should be a fresh UUID
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    // Session file should NOT be the parent's file (it was not forked)
    expect(result.sessionEntry.sessionFile).not.toBe(parentSessionFile);
  });

  it("skips fork when resolved parent token estimate exceeds threshold", async () => {
    const root = await makeCaseDir("openclaw-thread-session-overflow-estimated-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-overflow-estimated";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: parentSessionId,
      transcriptPath: parentSessionFile,
      events: [
        {
          type: "session",
          version: 3,
          id: parentSessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        },
      ],
    });

    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const parentSessionKey = "agent:main:slack:channel:c1";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
        totalTokens: 1,
        totalTokensFresh: false,
      },
    });
    sessionForkMocks.resolveParentForkTokenCount.mockReturnValueOnce(170_000);

    const cfg = {
      session: {},
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:estimated";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(sessionForkMocks.resolveParentForkTokenCount).toHaveBeenCalledWith({
      parentEntry: expect.objectContaining({
        sessionId: parentSessionId,
        totalTokensFresh: false,
      }),
      agentId: "main",
    });
    expect(result.sessionEntry.forkedFromParent).toBe(true);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.sessionFile).not.toBe(parentSessionFile);
    expect(sessionForkMocks.forkSessionFromParent).not.toHaveBeenCalled();
  });

  it("records topic-specific session files when MessageThreadId is present", async () => {
    const root = await makeCaseDir("openclaw-topic-session-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);

    const cfg = {
      session: {},
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello topic",
        SessionKey: "agent:main:telegram:group:123:topic:456",
        MessageThreadId: 456,
      },
      cfg,
      commandAuthorized: true,
    });

    const sessionFile = requireString(result.sessionEntry.sessionFile, "topic session file");
    expect(path.basename(sessionFile)).toBe(`${result.sessionEntry.sessionId}-topic-456.jsonl`);
  });

  it("records topic-specific session files from SessionKey when MessageThreadId is absent", async () => {
    const root = await makeCaseDir("openclaw-topic-session-key-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);

    const cfg = {
      session: {},
    } as OpenClawConfig;

    setActivePluginRegistry(createSessionConversationTestRegistry());
    try {
      const result = await initSessionState({
        ctx: {
          Body: "Hello topic",
          SessionKey: "agent:main:telegram:group:123:topic:456",
        },
        cfg,
        commandAuthorized: true,
      });

      const sessionFile = requireString(result.sessionEntry.sessionFile, "topic session file");
      expect(path.basename(sessionFile)).toBe(`${result.sessionEntry.sessionId}-topic-456.jsonl`);
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });
});

describe("initSessionState RawBody", () => {
  it("uses RawBody for command extraction and reset triggers when Body contains wrapped context", async () => {
    const root = await makeCaseDir("openclaw-rawbody-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const cfg = { session: {} } as OpenClawConfig;

    const statusResult = await initSessionState({
      ctx: {
        Body: `[Chat messages since your last reply - for context]\n[WhatsApp ...] Someone: hello\n\n[Current message - respond to this]\n[WhatsApp ...] Jake: /status\n[from: Jake McInteer (+6421807830)]`,
        RawBody: "/status",
        ChatType: "group",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(statusResult.triggerBodyNormalized).toBe("/status");

    const resetResult = await initSessionState({
      ctx: {
        Body: `[Context]\nJake: /new\n[from: Jake]`,
        RawBody: "/new",
        ChatType: "group",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(resetResult.isNewSession).toBe(true);
    expect(resetResult.bodyStripped).toBe("");
  });

  it("preserves argument casing while still matching reset triggers case-insensitively", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-case-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);

    const cfg = {
      session: {
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const ctx = {
      RawBody: "/NEW KeepThisCase",
      ChatType: "direct",
      SessionKey: "agent:main:whatsapp:dm:s1",
    };

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("KeepThisCase");
    expect(result.triggerBodyNormalized).toBe("/NEW KeepThisCase");
  });

  it("drops cached skills snapshot when /new rotates an existing session", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-skills-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:signal:direct:uuid:reset-skills";
    const existingSessionId = "session-with-stale-skills";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
        systemSent: true,
        skillsSnapshot: {
          prompt: "<available_skills><skill><name>stale</name></skill></available_skills>",
          skills: [{ name: "stale" }],
          version: 0,
        },
      },
    });

    const cfg = {
      session: {
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new continue",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.sessionEntry.skillsSnapshot).toBeUndefined();

    const store = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(store[sessionKey]?.skillsSnapshot).toBeUndefined();
  });

  it("drains stale system events when /new rotates an existing session", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-system-events-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:system-events";
    const existingSessionId = "session-with-stale-events";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
        systemSent: true,
      },
    });
    enqueueSystemEvent("stale session-key event", { sessionKey });
    enqueueSystemEvent("stale session-id event", { sessionKey: existingSessionId });

    const cfg = {
      session: {
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new continue",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    await expect(
      drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession: false,
        isNewSession: true,
      }),
    ).resolves.toBeUndefined();
    expect(peekSystemEvents(existingSessionId)).toStrictEqual([]);
  });

  it("rotates local session state for /new on bound ACP sessions", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-reset-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: {},
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "1478836151241412759" },
          },
          acp: { mode: "persistent" },
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new",
        CommandBody: "/new",
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: "1478836151241412759",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.isNewSession).toBe(true);
  });

  it("rotates local session state for ACP /new when no matching conversation binding exists", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-reset-no-conversation-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: {},
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new",
        CommandBody: "/new",
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: "user:12345",
        OriginatingTo: "user:12345",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.isNewSession).toBe(true);
  });

  it("keeps custom reset triggers working on bound ACP sessions", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-custom-reset-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: {
        resetTriggers: ["/fresh"],
      },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "1478836151241412759" },
          },
          acp: { mode: "persistent" },
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/fresh",
        CommandBody: "/fresh",
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: "1478836151241412759",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("keeps normal /new behavior for unbound ACP-shaped session keys", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-unbound-reset-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: {},
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new",
        CommandBody: "/new",
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: "1478836151241412759",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("does not suppress /new when active conversation binding points to a non-ACP session", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-nonacp-binding-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();
    const channelId = "1478836151241412759";
    const nonAcpFocusSessionKey = "agent:main:discord:channel:focus-target";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: {},
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
          acp: { mode: "persistent" },
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      capabilities: { bindSupported: false, unbindSupported: false, placements: ["current"] },
      listBySession: () => [],
      resolveByConversation: (ref) => {
        if (ref.conversationId !== channelId) {
          return null;
        }
        return {
          bindingId: "focus-binding",
          targetSessionKey: nonAcpFocusSessionKey,
          targetKind: "session",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: channelId,
          },
          status: "active",
          boundAt: now,
        };
      },
    });
    try {
      const result = await initSessionState({
        ctx: {
          RawBody: "/new",
          CommandBody: "/new",
          Provider: "discord",
          Surface: "discord",
          SenderId: "12345",
          From: "discord:12345",
          To: channelId,
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.resetTriggered).toBe(true);
      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
    } finally {
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
    }
  });

  it("does not suppress /new when active target session key is non-ACP even with configured ACP binding", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-configured-fallback-target-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const channelId = "1478836151241412759";
    const fallbackSessionKey = "agent:main:discord:channel:focus-target";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [fallbackSessionKey]: {
        sessionId: existingSessionId,
        updatedAt: now,
        systemSent: true,
      },
    });

    const cfg = {
      session: {},
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
          acp: { mode: "persistent" },
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new",
        CommandBody: "/new",
        Provider: "discord",
        Surface: "discord",
        SenderId: "12345",
        From: "discord:12345",
        To: channelId,
        SessionKey: fallbackSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("prefers native command target sessions over bound slash sessions", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("native-command-target-session-");
    const boundSlashSessionKey = "slack:slash:123";
    const targetSessionKey = "agent:main:main";
    const cfg = {
      session: {},
    } as OpenClawConfig;

    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      channel: "slack",
      accountId: "default",
    });
    await getSessionBindingService().bind({
      targetSessionKey: boundSlashSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "channel:ops",
      },
      placement: "current",
    });

    const result = await initSessionState({
      ctx: {
        Body: `/model openai-codex/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        CommandBody: `/model openai-codex/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        Provider: "slack",
        Surface: "slack",
        AccountId: "default",
        SenderId: "U123",
        From: "slack:U123",
        To: "channel:ops",
        OriginatingTo: "channel:ops",
        SessionKey: boundSlashSessionKey,
        CommandSource: "native",
        CommandTargetSessionKey: targetSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(targetSessionKey);
    expect(result.sessionCtx.SessionKey).toBe(targetSessionKey);
  });

  it("uses the default per-agent sessions store when config store is unset", async () => {
    const root = await makeCaseDir("openclaw-session-store-default-");
    const stateDir = path.join(root, ".openclaw");
    const agentId = "worker1";
    const sessionKey = `agent:${agentId}:telegram:12345`;
    const sessionId = "sess-worker-1";
    const sessionFile = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(
      path.join(stateDir, "agents", agentId, "sessions"),
      agentId,
    );

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      });

      const cfg = {} as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.sessionEntry.sessionId).toBe(sessionId);
      expect(result.sessionEntry.sessionFile).toBe(sessionFile);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      name: "Slack DM",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
      ctx: {
        Provider: "slack",
        Surface: "slack",
        From: "slack:user:U123",
        To: "user:U123",
        OriginatingTo: "user:U123",
        SenderId: "U123",
        ChatType: "direct",
      },
    },
    {
      name: "Signal DM",
      conversation: {
        channel: "signal",
        accountId: "default",
        conversationId: "+15550001111",
      },
      ctx: {
        Provider: "signal",
        Surface: "signal",
        From: "signal:+15550001111",
        To: "+15550001111",
        OriginatingTo: "signal:+15550001111",
        SenderId: "+15550001111",
        ChatType: "direct",
      },
    },
    {
      name: "Google Chat room",
      conversation: {
        channel: "googlechat",
        accountId: "default",
        conversationId: "spaces/AAAAAAA",
      },
      ctx: {
        Provider: "googlechat",
        Surface: "googlechat",
        From: "googlechat:users/123",
        To: "spaces/AAAAAAA",
        OriginatingTo: "googlechat:spaces/AAAAAAA",
        SenderId: "users/123",
        ChatType: "group",
      },
    },
  ])("routes generic current-conversation bindings for $name", async ({ conversation, ctx }) => {
    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      channel: conversation.channel as "slack" | "signal" | "googlechat",
      accountId: "default",
    });
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-generic-current-binding-");
    const boundSessionKey = `agent:codex:acp:binding:${conversation.channel}:default:test`;

    await getSessionBindingService().bind({
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation,
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "hello",
        SessionKey: `agent:main:${conversation.channel}:seed`,
        ...ctx,
      },
      cfg: {
        session: {},
      } as OpenClawConfig,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(boundSessionKey);
  });
});

describe("initSessionState reset policy", () => {
  let clearBootstrapSnapshotOnSessionRolloverSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    clearBootstrapSnapshotOnSessionRolloverSpy = vi.spyOn(
      bootstrapCache,
      "clearBootstrapSnapshotOnSessionRollover",
    );
  });

  afterEach(() => {
    clearBootstrapSnapshotOnSessionRolloverSpy.mockRestore();
    vi.useRealTimers();
  });

  it("defaults to daily reset at 4am local time", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:s1";
    const existingSessionId = "daily-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });
    enqueueSystemEvent("stale daily rollover event", { sessionKey });
    enqueueSystemEvent("stale daily rollover session-id event", {
      sessionKey: existingSessionId,
    });

    const cfg = { session: {} } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
      sessionKey,
      previousSessionId: existingSessionId,
    });
    await expect(
      drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession: false,
        isNewSession: true,
      }),
    ).resolves.toBeUndefined();
    expect(peekSystemEvents(existingSessionId)).toStrictEqual([]);
  });

  it("treats sessions as stale before the daily reset when updated before yesterday's boundary", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-edge-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:s-edge";
    const existingSessionId = "daily-edge-session";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
      },
    });

    const cfg = { session: {} } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("expires sessions when idle timeout wins over daily reset", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-idle-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:s2";
    const existingSessionId = "idle-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("drains stale system events when idle rollover creates a new session", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-idle-system-events-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:idle-system-events";
    const existingSessionId = "idle-system-events-session";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });
    enqueueSystemEvent("stale idle rollover event", { sessionKey });
    enqueueSystemEvent("stale idle rollover session-id event", {
      sessionKey: existingSessionId,
    });

    const cfg = {
      session: {
        reset: { mode: "idle", idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).not.toBe(existingSessionId);
    await expect(
      drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession: false,
        isNewSession: true,
      }),
    ).resolves.toBeUndefined();
    expect(peekSystemEvents(existingSessionId)).toStrictEqual([]);
  });

  it("keeps the existing stale session for /reset soft", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-soft-stale-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:soft-stale";
    const existingSessionId = "soft-stale-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/reset soft",
        RawBody: "/reset soft",
        CommandBody: "/reset soft",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).not.toHaveBeenCalledWith({
      sessionKey,
      previousSessionId: existingSessionId,
    });
  });

  it("keeps the existing stale session for /reset: soft", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-soft-colon-stale-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:soft-colon-stale";
    const existingSessionId = "soft-colon-stale-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/reset: soft",
        RawBody: "/reset: soft",
        CommandBody: "/reset: soft",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).not.toHaveBeenCalledWith({
      sessionKey,
      previousSessionId: existingSessionId,
    });
  });

  it("keeps the existing stale session for multiline /reset soft tails", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-soft-multiline-stale-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:soft-multiline-stale";
    const existingSessionId = "soft-multiline-stale-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/reset soft\nre-read persona files",
        RawBody: "/reset soft\nre-read persona files",
        CommandBody: "/reset soft\nre-read persona files",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).not.toHaveBeenCalledWith({
      sessionKey,
      previousSessionId: existingSessionId,
    });
  });

  it("does not preserve a stale session for unauthorized /reset soft", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-soft-stale-unauthorized-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:soft-stale-unauthorized";
    const existingSessionId = "soft-stale-unauthorized-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/reset soft",
        RawBody: "/reset soft",
        CommandBody: "/reset soft",
        Provider: "whatsapp",
        Surface: "whatsapp",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: false,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
      sessionKey,
      previousSessionId: existingSessionId,
    });
  });

  it("uses per-type overrides for thread sessions", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const existingSessionId = "thread-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { mode: "daily", atHour: 4 },
        resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Slack thread" },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("detects thread sessions without thread key suffix", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-nosuffix-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:discord:channel:c1";
    const existingSessionId = "thread-nosuffix";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Discord thread" },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("defaults to daily resets when only resetByType is configured", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-type-default-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:s4";
    const existingSessionId = "type-default-session";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        resetByType: { thread: { mode: "idle", idleMinutes: 60 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("keeps legacy idleMinutes behavior without reset config", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-legacy-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:whatsapp:dm:s3";
    const existingSessionId = "legacy-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        idleMinutes: 240,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
      sessionKey,
      previousSessionId: undefined,
    });
  });
});

describe("initSessionState browser tab cleanup", () => {
  it("closes tracked browser tabs when idle session expires", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-tab-cleanup-idle-");
    const sessionKey = "agent:main:whatsapp:dm:tab-idle";
    const existingSessionId = "tab-idle-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(browserMaintenanceMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKeys: expect.arrayContaining([existingSessionId, sessionKey]),
      }),
    );
  });

  it("closes tracked browser tabs on explicit /new reset", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-tab-cleanup-reset-");
    const sessionKey = "agent:main:telegram:dm:tab-reset";
    const existingSessionId = "tab-reset-session-id";

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { idleMinutes: 999 },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(browserMaintenanceMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKeys: expect.arrayContaining([existingSessionId, sessionKey]),
      }),
    );
  });

  it("does not close browser tabs for a fresh session without previous state", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-tab-cleanup-fresh-");
    const sessionKey = "agent:main:telegram:dm:tab-fresh";

    const cfg = {
      session: { idleMinutes: 999 },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(browserMaintenanceMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  });
});

describe("initSessionState channel reset overrides", () => {
  it("uses channel-specific reset policy when configured", async () => {
    const root = await makeCaseDir("openclaw-channel-idle-");
    const sessionRowsTarget = createSessionRowsTargetFromSessionsDir(root);
    const sessionKey = "agent:main:discord:dm:123";
    const sessionId = "session-override";
    const updatedAt = Date.now() - (10080 - 1) * 60_000;

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId,
        updatedAt,
      },
    });

    const cfg = {
      session: {
        idleMinutes: 60,
        resetByType: { direct: { mode: "idle", idleMinutes: 10 } },
        resetByChannel: { discord: { mode: "idle", idleMinutes: 10080 } },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello",
        SessionKey: sessionKey,
        Provider: "discord",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
  });
});

describe("initSessionState reset triggers in WhatsApp groups", () => {
  async function seedSessionStore(params: {
    target?: TestSessionRowsTarget;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await replaceSessionRowsForFixtureTarget(params.target ?? getCurrentTestSessionRowsTarget(), {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  function makeCfg(params: { allowFrom: string[] }): OpenClawConfig {
    return {
      session: { idleMinutes: 999 },
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
    } as OpenClawConfig;
  }

  it("applies WhatsApp group reset authorization across sender variants", async () => {
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    await createSessionRowsTarget("openclaw-group-reset");
    const cases = [
      {
        name: "authorized sender",
        allowFrom: ["+41796666864"],
        body: `[Chat messages since your last reply - for context]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Peschiño: /new\\n[from: Peschiño (+41796666864)]`,
        senderName: "Peschiño",
        senderE164: "+41796666864",
        senderId: "41796666864:0@s.whatsapp.net",
        expectedIsNewSession: true,
      },
      {
        name: "LID sender with unauthorized E164",
        allowFrom: ["+41796666864"],
        body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Other: /new\n[from: Other (+1555123456)]`,
        senderName: "Other",
        senderE164: "+1555123456",
        senderId: "123@lid",
        expectedIsNewSession: true,
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStore({
        sessionKey,
        sessionId: existingSessionId,
      });
      const cfg = makeCfg({
        allowFrom: [...testCase.allowFrom],
      });

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: "/new",
          CommandBody: "/new",
          From: "120363406150318674@g.us",
          To: "+41779241027",
          ChatType: "group",
          SessionKey: sessionKey,
          Provider: "whatsapp",
          Surface: "whatsapp",
          SenderName: testCase.senderName,
          SenderE164: testCase.senderE164,
          SenderId: testCase.senderId,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.triggerBodyNormalized, testCase.name).toBe("/new");
      expect(result.isNewSession, testCase.name).toBe(testCase.expectedIsNewSession);
      if (testCase.expectedIsNewSession) {
        expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
        expect(result.bodyStripped, testCase.name).toBe("");
      } else {
        expect(result.sessionId, testCase.name).toBe(existingSessionId);
      }
    }
  });

  it("starts a fresh session when a scoped WhatsApp group entry only contains activation state", async () => {
    const sessionKey =
      "agent:main:whatsapp:group:120363406150318674@g.us:thread:whatsapp-account-work";
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-group-activation-backfill-");
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        groupActivation: "always",
      },
    });
    const cfg = makeCfg({
      allowFrom: ["+41796666864"],
    });

    const result = await initSessionState({
      ctx: {
        Body: "hello without mention",
        RawBody: "hello without mention",
        CommandBody: "hello without mention",
        From: "120363406150318674@g.us",
        To: "+41779241027",
        ChatType: "group",
        SessionKey: sessionKey,
        Provider: "whatsapp",
        Surface: "whatsapp",
        SenderName: "Peschiño",
        SenderE164: "+41796666864",
        SenderId: "41796666864:0@s.whatsapp.net",
      },
      cfg,
      commandAuthorized: false,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.sessionEntry.groupActivation).toBe("always");
    expect(result.sessionEntry.sessionId).toBe(result.sessionId);
    expect(typeof result.sessionEntry.updatedAt).toBe("number");
  });
});

describe("initSessionState reset triggers in Slack channels", () => {
  async function seedSessionStore(params: {
    target?: TestSessionRowsTarget;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await replaceSessionRowsForFixtureTarget(params.target ?? getCurrentTestSessionRowsTarget(), {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  it("supports mention-prefixed Slack reset commands and preserves args", async () => {
    setMinimalCurrentConversationBindingRegistryForTests();
    const existingSessionId = "existing-session-123";
    const sessionKey = "agent:main:slack:channel:c2";
    const body = "<@U123> /new take notes";
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-slack-channel-new-");
    await seedSessionStore({
      sessionKey,
      sessionId: existingSessionId,
    });
    const cfg = {
      session: { idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: body,
        RawBody: body,
        BodyForCommands: "/new take notes",
        CommandBody: body,
        From: "slack:channel:C1",
        To: "channel:C1",
        ChatType: "channel",
        SessionKey: sessionKey,
        Provider: "slack",
        Surface: "slack",
        SenderId: "U123",
        SenderName: "Owner",
        WasMentioned: true,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("take notes");
  });
});

describe("initSessionState preserves behavior overrides across /new and /reset", () => {
  async function seedSessionStoreWithOverrides(params: {
    target?: TestSessionRowsTarget;
    sessionKey: string;
    sessionId: string;
    overrides: Record<string, unknown>;
  }): Promise<void> {
    await replaceSessionRowsForFixtureTarget(params.target ?? getCurrentTestSessionRowsTarget(), {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.overrides,
      },
    });
  }

  it("preserves behavior overrides across /new and /reset", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-reset-overrides-");
    const sessionKey = "agent:main:telegram:dm:user-overrides";
    const existingSessionId = "existing-session-overrides";
    const overrides = {
      verboseLevel: "on",
      thinkingLevel: "high",
      reasoningLevel: "low",
      label: "telegram-priority",
    } as const;
    const cases = [
      {
        name: "new preserves behavior overrides",
        body: "/new",
      },
      {
        name: "reset preserves behavior overrides",
        body: "/reset",
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        sessionKey,
        sessionId: existingSessionId,
        overrides: { ...overrides },
      });

      const cfg = {
        session: { idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "user-overrides",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry, testCase.name).toMatchObject(overrides);
    }
  });

  it("preserves usage family metadata across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-usage-family-");
    const sessionKey = "agent:main:telegram:dm:user-usage-family";
    const existingSessionId = "existing-session-usage-family";
    const cases = [
      {
        name: "new preserves usage family metadata",
        body: "/new",
      },
      {
        name: "reset preserves usage family metadata",
        body: "/reset",
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        storePath,
        sessionKey,
        sessionId: existingSessionId,
        overrides: {
          usageFamilyKey: "family:user-usage-family",
          usageFamilySessionIds: ["ancestor-session", existingSessionId],
        },
      });

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "user-usage-family",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg: {
          session: { store: storePath, idleMinutes: 999 },
        } as OpenClawConfig,
        commandAuthorized: true,
      });

      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry.usageFamilyKey, testCase.name).toBe("family:user-usage-family");
      expect(result.sessionEntry.usageFamilySessionIds, testCase.name).toEqual([
        "ancestor-session",
        existingSessionId,
        result.sessionId,
      ]);

      const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(stored[sessionKey].usageFamilyKey, testCase.name).toBe("family:user-usage-family");
      expect(stored[sessionKey].usageFamilySessionIds, testCase.name).toEqual([
        "ancestor-session",
        existingSessionId,
        result.sessionId,
      ]);
    }
  });

  it("preserves selected auth profile overrides across /new and /reset", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-reset-model-auth-");
    const sessionKey = "agent:main:telegram:dm:user-model-auth";
    const existingSessionId = "existing-session-model-auth";
    const overrides = {
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      authProfileOverride: "20251001",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
      cliSessionIds: { "claude-cli": "cli-session-123" },
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "cli-session-123",
          authProfileId: "anthropic:default",
        },
      },
      claudeCliSessionId: "cli-session-123",
    } as const;
    const cases = [
      {
        name: "new preserves selected auth profile overrides",
        body: "/new",
      },
      {
        name: "reset preserves selected auth profile overrides",
        body: "/reset",
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        sessionKey,
        sessionId: existingSessionId,
        overrides: { ...overrides },
      });

      const cfg = {
        session: { idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "user-model-auth",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry, testCase.name).toMatchObject({
        providerOverride: overrides.providerOverride,
        modelOverride: overrides.modelOverride,
        authProfileOverride: overrides.authProfileOverride,
        authProfileOverrideSource: overrides.authProfileOverrideSource,
        authProfileOverrideCompactionCount: overrides.authProfileOverrideCompactionCount,
      });
      expect(result.sessionEntry.cliSessionIds).toBeUndefined();
      expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
      expect(result.sessionEntry.claudeCliSessionId).toBeUndefined();

      const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
      expect(stored[sessionKey].cliSessionIds).toBeUndefined();
      expect(stored[sessionKey].cliSessionBindings).toBeUndefined();
      expect(stored[sessionKey].claudeCliSessionId).toBeUndefined();
    }
  });

  it("clears auto-sourced model/provider/auth overrides on /new and /reset (#69301)", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-reset-auto-overrides-");
    const sessionKey = "agent:main:telegram:direct:6761477233";
    const existingSessionId = "existing-session-auto-overrides";
    const autoOverrides = {
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 1,
      verboseLevel: "on",
    } as const;
    const cases = [
      { name: "new clears auto-sourced overrides", body: "/new" },
      { name: "reset clears auto-sourced overrides", body: "/reset" },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        sessionKey,
        sessionId: existingSessionId,
        overrides: { ...autoOverrides },
      });

      const cfg = {
        session: { idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "6761477233",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry.modelOverride, testCase.name).toBeUndefined();
      expect(result.sessionEntry.providerOverride, testCase.name).toBeUndefined();
      expect(result.sessionEntry.modelOverrideSource, testCase.name).toBeUndefined();
      expect(result.sessionEntry.authProfileOverride, testCase.name).toBeUndefined();
      expect(result.sessionEntry.authProfileOverrideSource, testCase.name).toBeUndefined();
      expect(result.sessionEntry.authProfileOverrideCompactionCount, testCase.name).toBeUndefined();
      // Unrelated behavior overrides still carry across the reset.
      expect(result.sessionEntry.verboseLevel, testCase.name).toBe(autoOverrides.verboseLevel);
    }
  });

  it("preserves spawned session ownership metadata across /new and /reset", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-reset-spawned-metadata-");
    const sessionKey = "subagent:owned-child";
    const existingSessionId = "existing-session-owned-child";
    const overrides = {
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/child-workspace",
      parentSessionKey: "agent:main:main",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      displayName: "Ops Child",
    } as const;
    const cases = [
      { name: "new preserves spawned session ownership metadata", body: "/new" },
      { name: "reset preserves spawned session ownership metadata", body: "/reset" },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        sessionKey,
        sessionId: existingSessionId,
        overrides: { ...overrides },
      });

      const cfg = {
        session: { idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "user-owned-child",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry).toMatchObject(overrides);
    }
  });

  it("requires operator.admin when Provider is internal even if Surface carries external metadata", async () => {
    const sessionRowsTarget = await createSessionRowsTarget(
      "openclaw-internal-reset-provider-authoritative-",
    );
    const sessionKey = "agent:main:telegram:dm:provider-authoritative";
    const existingSessionId = "existing-session-provider-authoritative";

    await seedSessionStoreWithOverrides({
      sessionKey,
      sessionId: existingSessionId,
      overrides: {},
    });

    const cfg = {
      session: { idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        Provider: "webchat",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        GatewayClientScopes: ["operator.write"],
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("keeps the existing session for /reset soft", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-soft-reset-session-");
    const sessionKey = "agent:main:telegram:dm:user-soft-reset";
    const existingSessionId = "existing-session-soft-reset";

    await seedSessionStoreWithOverrides({
      sessionKey,
      sessionId: existingSessionId,
      overrides: {
        cliSessionIds: { "claude-cli": "cli-session-1" },
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "cli-session-1",
            extraSystemPromptHash: "prompt-hash",
          },
        },
      },
    });

    const cfg = {
      session: { idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/reset soft",
        RawBody: "/reset soft",
        CommandBody: "/reset soft",
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("keeps the existing session for /reset newline soft", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-reset-newline-soft-");
    const sessionKey = "agent:main:telegram:dm:user-reset-newline-soft";
    const existingSessionId = "existing-session-reset-newline-soft";

    await seedSessionStoreWithOverrides({
      sessionKey,
      sessionId: existingSessionId,
      overrides: {},
    });

    const cfg = {
      session: { idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/reset \nsoft",
        RawBody: "/reset \nsoft",
        CommandBody: "/reset \nsoft",
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("deletes the old SQLite transcript on /new", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-archive-old-");
    const sessionKey = "agent:main:telegram:dm:user-archive";
    const existingSessionId = "existing-session-archive";
    const transcriptPath = path.join(sessionRowsTarget.sessionsDir, `${existingSessionId}.jsonl`);
    await seedSessionStoreWithOverrides({
      sessionKey,
      sessionId: existingSessionId,
      overrides: { sessionFile: transcriptPath, verboseLevel: "on" },
    });
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId: existingSessionId,
      transcriptPath,
      events: [{ type: "message" }],
    });

    const cfg = {
      session: { idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-archive",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(
      loadSqliteSessionTranscriptEvents({ agentId: "main", sessionId: existingSessionId }),
    ).toEqual([]);
  });

  it("deletes the old SQLite transcript on daily/scheduled reset (stale session)", async () => {
    // Daily resets occur when the session becomes stale (not via /new or /reset command).
    // Previously, previousSessionEntry was only set when resetTriggered=true, leaving
    // old transcript files orphaned on disk. Refs #35481.
    vi.useFakeTimers();
    try {
      // Simulate: it is 5am, session was last active at 3am (before 4am daily boundary)
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionRowsTarget = await createSessionRowsTarget("openclaw-stale-archive-");
      const sessionKey = "agent:main:telegram:dm:archive-stale-user";
      const existingSessionId = "stale-session-to-delete";
      const transcriptPath = path.join(sessionRowsTarget.sessionsDir, `${existingSessionId}.jsonl`);

      await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
        [sessionKey]: {
          sessionId: existingSessionId,
          sessionFile: transcriptPath,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      replaceSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: existingSessionId,
        transcriptPath,
        events: [{ type: "message" }],
      });

      const cfg = { session: {} } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "user-stale",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).not.toBe(existingSessionId);
      expect(
        loadSqliteSessionTranscriptEvents({ agentId: "main", sessionId: existingSessionId }),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps provider-owned CLI sessions on implicit daily reset boundaries", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const sessionRowsTarget = await createSessionRowsTarget("openclaw-cli-implicit-reset-");
      const sessionKey = "agent:main:telegram:dm:claude-cli-user";
      const existingSessionId = "provider-owned-session";
      const transcriptPath = path.join(sessionRowsTarget.sessionsDir, `${existingSessionId}.jsonl`);
      const cliBinding = {
        sessionId: "claude-session-1",
        authProfileId: "anthropic:claude-cli",
        mcpResumeHash: "mcp-resume-hash",
      };

      await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
        [sessionKey]: {
          sessionId: existingSessionId,
          sessionFile: transcriptPath,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
          modelProvider: "claude-cli",
          model: "claude-opus-4-6",
          cliSessionBindings: {
            "claude-cli": cliBinding,
          },
          cliSessionIds: {
            "claude-cli": cliBinding.sessionId,
          },
          claudeCliSessionId: cliBinding.sessionId,
        },
      });
      replaceSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: existingSessionId,
        transcriptPath,
        events: [{ type: "message" }],
      });

      const cfg = { session: {} } as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "claude-cli-user",
          To: "bot",
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(result.sessionEntry.cliSessionBindings?.["claude-cli"]).toEqual(cliBinding);
      expect(
        loadSqliteSessionTranscriptEvents({ agentId: "main", sessionId: existingSessionId }),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors explicit reset policies for provider-owned CLI sessions", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-cli-explicit-reset-");
    const sessionKey = "agent:main:telegram:dm:claude-cli-explicit-user";
    const existingSessionId = "provider-owned-explicit-session";
    const cfg = {
      session: {
        reset: { mode: "idle", idleMinutes: 1 },
      },
    } as OpenClawConfig;

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 5 * 60_000,
        modelProvider: "claude-cli",
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-session-explicit",
          },
        },
      },
    });

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "claude-cli-explicit-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
  });

  it("disposes the previous bundle MCP runtime on session rollover", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-stale-runtime-dispose-");
    const sessionKey = "agent:main:telegram:dm:runtime-stale-user";
    const existingSessionId = "stale-runtime-session";
    const cfg = {
      session: {
        reset: { mode: "idle", idleMinutes: 1 },
      },
    } as OpenClawConfig;

    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 5 * 60_000,
      },
    });

    await getOrCreateSessionMcpRuntime({
      sessionId: existingSessionId,
      sessionKey,
      workspaceDir: sessionRowsTarget.sessionsDir,
      cfg,
    });

    expect(sessionMcpTesting.getCachedSessionIds()).toContain(existingSessionId);

    await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "user-stale-runtime",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(sessionMcpTesting.getCachedSessionIds()).not.toContain(existingSessionId);
  });

  it("idle-based new session does NOT preserve overrides (no entry to read)", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-idle-no-preserve-");
    const sessionKey = "agent:main:telegram:dm:new-user";

    const cfg = {
      session: { idleMinutes: 0 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "new-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.verboseLevel).toBeUndefined();
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
  });
});

describe("drainFormattedSystemEvents", () => {
  it("adds a local timestamp to queued system events by default", async () => {
    vi.useFakeTimers();
    try {
      const timestamp = new Date("2026-01-12T20:19:17Z");
      const expectedTimestamp = formatZonedTimestamp(timestamp, { displaySeconds: true });
      vi.setSystemTime(timestamp);

      enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

      const result = await drainFormattedSystemEvents({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        isMainSession: true,
        isNewSession: false,
      });

      const expectedTimestampText = requireString(expectedTimestamp, "formatted timestamp");
      expect(result).toContain(`System: [${expectedTimestampText}] Model switched.`);
    } finally {
      resetSystemEventsForTest();
      vi.useRealTimers();
    }
  });

  it("keeps channel summary lines prefixed as trusted system output on new main sessions", async () => {
    channelSummaryMocks.buildChannelSummary.mockResolvedValue([
      "WhatsApp: linked\n  - default (line one\nline two)",
    ]);

    const result = await drainFormattedSystemEvents({
      cfg: { channels: {} } as OpenClawConfig,
      sessionKey: "agent:main:main",
      isMainSession: true,
      isNewSession: true,
    });

    expect(result).toContain("System: WhatsApp: linked");
    for (const line of result!.split("\n")) {
      expect(line).toMatch(/^System:/);
    }
  });
});

describe("persistSessionUsageUpdate", () => {
  async function seedSessionStore(params: {
    target?: TestSessionRowsTarget;
    sessionKey: string;
    entry: Record<string, unknown>;
  }) {
    await replaceSessionRowsForFixtureTarget(params.target ?? getCurrentTestSessionRowsTarget(), {
      [params.sessionKey]: params.entry,
    });
  }

  it("uses lastCallUsage for totalTokens when provided", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now(), totalTokens: 100_000 },
    });

    const accumulatedUsage = { input: 180_000, output: 10_000, total: 190_000 };
    const lastCallUsage = { input: 12_000, output: 2_000, total: 14_000 };

    await persistSessionUsageUpdate({
      sessionKey,
      usage: accumulatedUsage,
      lastCallUsage,
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(180_000);
    expect(stored[sessionKey].outputTokens).toBe(10_000);
  });

  it("uses lastCallUsage cache counters when available", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-cache-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      sessionKey,
      usage: {
        input: 100_000,
        output: 8_000,
        cacheRead: 260_000,
        cacheWrite: 90_000,
      },
      lastCallUsage: {
        input: 12_000,
        output: 1_000,
        cacheRead: 18_000,
        cacheWrite: 4_000,
      },
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].inputTokens).toBe(100_000);
    expect(stored[sessionKey].outputTokens).toBe(8_000);
    expect(stored[sessionKey].cacheRead).toBe(18_000);
    expect(stored[sessionKey].cacheWrite).toBe(4_000);
  });

  it("marks totalTokens as unknown when no fresh context snapshot is available", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      sessionKey,
      usage: { input: 50_000, output: 5_000, total: 55_000 },
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].totalTokens).toBeUndefined();
    expect(stored[sessionKey].totalTokensFresh).toBe(false);
  });

  it("uses promptTokens when available without lastCallUsage", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      sessionKey,
      usage: { input: 50_000, output: 5_000, total: 55_000 },
      promptTokens: 42_000,
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].totalTokens).toBe(42_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("treats CLI usage as a fresh context snapshot when requested", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-cli-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      sessionKey,
      usage: { input: 24_000, output: 2_000, cacheRead: 8_000 },
      usageIsContextSnapshot: true,
      providerUsed: "claude-cli",
      cliSessionBinding: {
        sessionId: "cli-session-1",
        authProfileId: "anthropic:default",
        extraSystemPromptHash: "prompt-hash",
        mcpConfigHash: "mcp-hash",
      },
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].totalTokens).toBe(32_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(stored[sessionKey].cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "cli-session-1",
      authProfileId: "anthropic:default",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
    });
  });

  it("persists totalTokens from promptTokens when usage is unavailable", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        inputTokens: 1_234,
        outputTokens: 456,
      },
    });

    await persistSessionUsageUpdate({
      sessionKey,
      usage: undefined,
      promptTokens: 39_000,
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].totalTokens).toBe(39_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(1_234);
    expect(stored[sessionKey].outputTokens).toBe(456);
  });

  it("keeps non-clamped lastCallUsage totalTokens when exceeding context window", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      sessionKey,
      usage: { input: 300_000, output: 10_000, total: 310_000 },
      lastCallUsage: { input: 250_000, output: 5_000, total: 255_000 },
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].totalTokens).toBe(250_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("snapshots estimatedCostUsd instead of accumulating (fixes #69347)", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-cost-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: {
        sessionId: "s1",
        updatedAt: Date.now(),
      },
    });

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT 5.4",
                reasoning: true,
                input: ["text"],
                cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.5 },
                contextWindow: 200_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    };

    // First persist: 2000 input + 500 output + 1000 cacheRead + 200 cacheWrite tokens
    // Cost = (2000*1.25 + 500*10 + 1000*0.125 + 200*0.5) / 1e6 = $0.007725
    await persistSessionUsageUpdate({
      sessionKey,
      cfg,
      usage: { input: 2_000, output: 500, cacheRead: 1_000, cacheWrite: 200 },
      lastCallUsage: { input: 800, output: 200, cacheRead: 300, cacheWrite: 50 },
      providerUsed: "openai",
      modelUsed: "gpt-5.4",
      contextTokensUsed: 200_000,
    });

    const stored1 = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored1[sessionKey].estimatedCostUsd).toBeCloseTo(0.007725, 8);

    // Second persist with SAME cumulative usage (e.g., heartbeat or redundant persist)
    // Before fix: cost would accumulate to $0.0155 (2x)
    // After fix: cost stays $0.00775 (snapshotted)
    await persistSessionUsageUpdate({
      sessionKey,
      cfg,
      usage: { input: 2_000, output: 500, cacheRead: 1_000, cacheWrite: 200 },
      lastCallUsage: { input: 800, output: 200, cacheRead: 300, cacheWrite: 50 },
      providerUsed: "openai",
      modelUsed: "gpt-5.4",
      contextTokensUsed: 200_000,
    });

    const stored2 = readSessionRowsForFixtureTarget(sessionRowsTarget);
    // Cost should still be $0.007725, NOT $0.01545
    expect(stored2[sessionKey].estimatedCostUsd).toBeCloseTo(0.007725, 8);
  });

  it("persists zero estimatedCostUsd for free priced models", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("openclaw-usage-free-cost-");
    const sessionKey = "main";
    await seedSessionStore({
      sessionKey,
      entry: {
        sessionId: "s1",
        updatedAt: Date.now(),
      },
    });

    await persistSessionUsageUpdate({
      sessionKey,
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.3-codex-spark",
                  name: "GPT 5.3 Codex Spark",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig,
      usage: { input: 5_107, output: 1_827, cacheRead: 1_536, cacheWrite: 0 },
      lastCallUsage: { input: 5_107, output: 1_827, cacheRead: 1_536, cacheWrite: 0 },
      providerUsed: "openai-codex",
      modelUsed: "gpt-5.3-codex-spark",
      contextTokensUsed: 200_000,
    });

    const stored = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(stored[sessionKey].estimatedCostUsd).toBe(0);
  });
});

describe("initSessionState stale threadId fallback", () => {
  it("does not inherit lastThreadId from a previous thread interaction in non-thread sessions", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("stale-thread-");
    const cfg = { session: {} } as OpenClawConfig;

    // First interaction: inside a DM topic (thread session)
    const threadResult = await initSessionState({
      ctx: {
        Body: "hello from topic",
        SessionKey: "agent:main:main:thread:42",
        MessageThreadId: 42,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(threadResult.sessionEntry.lastThreadId).toBe(42);

    // Second interaction: plain DM (non-thread session), same store
    // The main session should NOT inherit threadId=42
    const mainResult = await initSessionState({
      ctx: {
        Body: "hello from DM",
        SessionKey: "agent:main:main",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(mainResult.sessionEntry.lastThreadId).toBeUndefined();
    expect(mainResult.sessionEntry.deliveryContext?.threadId).toBeUndefined();
  });

  it("preserves lastThreadId within the same thread session", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("preserve-thread-");
    const cfg = { session: {} } as OpenClawConfig;

    // First message in thread
    await initSessionState({
      ctx: {
        Body: "first",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });

    // Second message in same thread (MessageThreadId still present)
    const result = await initSessionState({
      ctx: {
        Body: "second",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(result.sessionEntry.lastThreadId).toBe(99);
  });
});

describe("initSessionState dmScope delivery migration", () => {
  it("retires stale main-session delivery route when dmScope uses per-channel DM keys", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("dm-scope-retire-main-route-");
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      "agent:main:main": {
        sessionId: "legacy-main",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "6101296751",
        lastAccountId: "default",
        deliveryContext: {
          channel: "telegram",
          to: "6101296751",
          accountId: "default",
        },
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer" },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:telegram:direct:6101296751",
        OriginatingChannel: "telegram",
        OriginatingTo: "6101296751",
        AccountId: "default",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe("agent:main:telegram:direct:6101296751");
    const persisted = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(persisted["agent:main:main"]?.sessionId).toBe("legacy-main");
    expect(persisted["agent:main:main"]?.deliveryContext).toBeUndefined();
    expect(persisted["agent:main:main"]?.lastChannel).toBeUndefined();
    expect(persisted["agent:main:main"]?.lastTo).toBeUndefined();
    expect(persisted["agent:main:telegram:direct:6101296751"]?.deliveryContext?.to).toBe(
      "6101296751",
    );
  });

  it("keeps legacy main-session delivery route when current DM target does not match", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("dm-scope-keep-main-route-");
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      "agent:main:main": {
        sessionId: "legacy-main",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "1111",
        lastAccountId: "default",
        deliveryContext: {
          channel: "telegram",
          to: "1111",
          accountId: "default",
        },
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer" },
    } as OpenClawConfig;

    await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:telegram:direct:6101296751",
        OriginatingChannel: "telegram",
        OriginatingTo: "6101296751",
        AccountId: "default",
      },
      cfg,
      commandAuthorized: true,
    });

    const persisted = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(persisted["agent:main:main"]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "1111",
      accountId: "default",
    });
    expect(persisted["agent:main:main"]?.lastTo).toBe("1111");
  });
});

describe("initSessionState internal channel routing preservation", () => {
  it("clears stale thread routing on non-thread system-event sessions", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("system-event-clears-stale-thread-");
    const sessionKey = "agent:main:mattermost:channel:chan1";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-system-event-stale-thread",
        updatedAt: Date.now(),
        lastChannel: "mattermost",
        lastTo: "channel:CHAN1",
        lastAccountId: "default",
        lastThreadId: "stale-root",
        deliveryContext: {
          channel: "mattermost",
          to: "channel:CHAN1",
          accountId: "default",
          threadId: "stale-root",
        },
        origin: {
          provider: "mattermost",
          to: "channel:CHAN1",
          accountId: "default",
          threadId: "stale-root",
        },
      },
    });
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "heartbeat tick",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        From: "heartbeat",
        To: "heartbeat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("mattermost");
    expect(result.sessionEntry.lastTo).toBe("channel:CHAN1");
    expect(result.sessionEntry.lastThreadId).toBeUndefined();
    expect(result.sessionEntry.deliveryContext).toEqual({
      channel: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });
    expect(result.sessionEntry.origin).toEqual({
      provider: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });

    const persisted = readSessionRowsForFixtureTarget(sessionRowsTarget);
    expect(persisted[sessionKey]?.lastThreadId).toBeUndefined();
    expect(persisted[sessionKey]?.deliveryContext).toEqual({
      channel: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });
    expect(persisted[sessionKey]?.origin).toEqual({
      provider: "mattermost",
      to: "channel:CHAN1",
      accountId: "default",
    });
  });

  it("does not synthesize heartbeat routing on a session with no external route", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("system-event-no-route-");
    const sessionKey = "agent:main:main";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-system-event-no-route",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "HEARTBEAT_OK",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        From: "heartbeat",
        To: "heartbeat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBeUndefined();
    expect(result.sessionEntry.lastTo).toBeUndefined();
    expect(result.sessionEntry.deliveryContext).toBeUndefined();
    expect(result.sessionEntry.origin).toBeUndefined();
  });

  it("preserves the existing user route when a heartbeat targets a different chat on the shared session", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("system-event-preserve-user-route-");
    const sessionKey = "agent:main:main";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-system-event-shared",
        updatedAt: Date.now(),
        lastChannel: "feishu",
        lastTo: "user:ou_sender_1",
        deliveryContext: {
          channel: "feishu",
          to: "user:ou_sender_1",
          accountId: "default",
        },
        origin: {
          provider: "feishu",
          from: "user:ou_sender_1",
          to: "user:ou_sender_1",
          accountId: "default",
        },
      },
    });
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "heartbeat tick",
        SessionKey: sessionKey,
        Provider: "heartbeat",
        From: "chat:oc_group_chat",
        To: "chat:oc_group_chat",
        OriginatingChannel: "feishu",
        OriginatingTo: "chat:oc_group_chat",
        AccountId: "default",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("feishu");
    expect(result.sessionEntry.lastTo).toBe("user:ou_sender_1");
    expect(result.sessionEntry.deliveryContext).toEqual({
      channel: "feishu",
      to: "user:ou_sender_1",
      accountId: "default",
    });
    expect(result.sessionEntry.origin).toEqual({
      provider: "feishu",
      from: "user:ou_sender_1",
      to: "user:ou_sender_1",
      accountId: "default",
    });
  });

  it("keeps persisted external lastChannel when OriginatingChannel is internal webchat", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("preserve-external-channel-");
    const sessionKey = "agent:main:telegram:group:12345";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "group:12345",
        deliveryContext: {
          channel: "telegram",
          to: "group:12345",
        },
      },
    });
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "internal follow-up",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.lastTo).toBe("group:12345");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("telegram");
    expect(result.sessionEntry.deliveryContext?.to).toBe("group:12345");
  });

  it("preserves persisted external route when webchat views a channel-peer session (fixes #47745)", async () => {
    // Regression: dashboard/webchat access must not overwrite an established
    // external delivery route (e.g. Telegram/iMessage) on a channel-scoped session.
    // Subagent completions should still be delivered to the original channel.
    const sessionRowsTarget = await createSessionRowsTarget("webchat-direct-route-preserve-");
    const sessionKey = "agent:main:imessage:direct:+1555";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-webchat-direct",
        updatedAt: Date.now(),
        lastChannel: "imessage",
        lastTo: "+1555",
        deliveryContext: {
          channel: "imessage",
          to: "+1555",
        },
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer" },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "reply from control ui",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        Surface: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    // External route must be preserved — webchat is admin/monitoring only
    expect(result.sessionEntry.lastChannel).toBe("imessage");
    expect(result.sessionEntry.lastTo).toBe("+1555");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("imessage");
    expect(result.sessionEntry.deliveryContext?.to).toBe("+1555");
  });

  it("lets direct webchat turns own routing for sessions with no prior external route", async () => {
    // Webchat should still own routing for sessions that were created via webchat
    // (no external channel ever established).
    const sessionRowsTarget = await createSessionRowsTarget("webchat-direct-route-noext-");
    const sessionKey = "agent:main:main";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-webchat-noext",
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer" },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "reply from control ui",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        Surface: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("webchat");
    expect(result.sessionEntry.lastTo).toBe("session:dashboard");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("webchat");
    expect(result.sessionEntry.deliveryContext?.to).toBe("session:dashboard");
  });

  it("keeps persisted external route when OriginatingChannel is non-deliverable", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("preserve-nondeliverable-route-");
    const sessionKey = "agent:main:discord:channel:24680";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-2",
        updatedAt: Date.now(),
        lastChannel: "discord",
        lastTo: "channel:24680",
        deliveryContext: {
          channel: "discord",
          to: "channel:24680",
        },
      },
    });
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "internal handoff",
        SessionKey: sessionKey,
        OriginatingChannel: "sessions_send",
        OriginatingTo: "session:handoff",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("discord");
    expect(result.sessionEntry.lastTo).toBe("channel:24680");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("discord");
    expect(result.sessionEntry.deliveryContext?.to).toBe("channel:24680");
  });

  it("uses session key channel hint when first turn is internal webchat", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("session-key-channel-hint-");
    const sessionKey = "agent:main:telegram:group:98765";
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("telegram");
  });

  it("keeps internal route when there is no persisted external fallback", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("no-external-fallback-");
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "handoff only",
        SessionKey: "agent:main:main",
        OriginatingChannel: "sessions_send",
        OriginatingTo: "session:handoff",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("sessions_send");
    expect(result.sessionEntry.lastTo).toBe("session:handoff");
  });

  it("keeps webchat channel for webchat/main sessions", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("preserve-webchat-main-");
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:main",
        OriginatingChannel: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("webchat");
  });

  it("preserves external route for main session when webchat accesses without destination (fixes #47745)", async () => {
    // Regression: webchat monitoring a main session that has an established WhatsApp
    // route must not clear that route. Subagents should still deliver to WhatsApp.
    const sessionRowsTarget = await createSessionRowsTarget("webchat-main-preserve-external-");
    const sessionKey = "agent:main:main";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-webchat-main-1",
        updatedAt: Date.now(),
        lastChannel: "whatsapp",
        lastTo: "+15555550123",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15555550123",
        },
      },
    });
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "webchat follow-up",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("whatsapp");
    expect(result.sessionEntry.lastTo).toBe("+15555550123");
  });

  it("preserves external route for main session when webchat sends with destination (fixes #47745)", async () => {
    // Regression: webchat sending to a main session with an established WhatsApp route
    // must not steal that route for webchat delivery.
    const sessionRowsTarget = await createSessionRowsTarget("preserve-main-external-webchat-send-");
    const sessionKey = "agent:main:main";
    await replaceSessionRowsForFixtureTarget(sessionRowsTarget, {
      [sessionKey]: {
        sessionId: "sess-webchat-main-2",
        updatedAt: Date.now(),
        lastChannel: "whatsapp",
        lastTo: "+15555550123",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15555550123",
        },
      },
    });
    const cfg = { session: {} } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "reply only here",
        SessionKey: sessionKey,
        OriginatingChannel: "webchat",
        OriginatingTo: "session:webchat-main",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("whatsapp");
    expect(result.sessionEntry.lastTo).toBe("+15555550123");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("whatsapp");
    expect(result.sessionEntry.deliveryContext?.to).toBe("+15555550123");
  });

  it("uses the configured default account for persisted routing when AccountId is omitted", async () => {
    const sessionRowsTarget = await createSessionRowsTarget("default-account-routing-context-");
    const cfg = {
      session: {},
      channels: {
        discord: {
          defaultAccount: "work",
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:discord:channel:24680",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastAccountId).toBe("work");
    expect(result.sessionEntry.deliveryContext?.accountId).toBe("work");
  });
});
