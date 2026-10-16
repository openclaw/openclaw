import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionEntry } from "../../config/sessions.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import {
  createFreshSessionEntry,
  createMemoryFlushPlan,
  createSessionEntry,
} from "./agent-runner-memory.test-support.js";
import {
  createTestFollowupRun,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";

const { compactEmbeddedAgentSessionMock, incrementCompactionCountMock } = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
  incrementCompactionCountMock: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: vi.fn(),
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
}));
vi.mock("./session-updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-updates.js")>()),
  incrementCompactionCount: incrementCompactionCountMock,
}));
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  refreshQueuedFollowupSession: vi.fn(),
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-preflight-stale-");

describe("runSessionCompactionIfNeeded stale totalTokens gating", () => {
  let rootDir = "";
  const sessionKey = "agent:main:main";
  const defaultModel = "anthropic/claude-opus-4-6";
  const compaction = { memoryFlush: {} };

  beforeEach(() => {
    rootDir = sessionDirs.make();
    registerMemoryCapability("memory-core", { flushPlanResolver: createMemoryFlushPlan });
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    incrementCompactionCountMock.mockReset().mockResolvedValue(1);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    clearMemoryPluginState();
  });

  async function runWithEntry(
    sessionEntry: SessionEntry,
    sessionFile: string,
    overrides: Partial<Parameters<typeof runSessionCompactionIfNeeded>[0]> = {},
  ) {
    const followupRun =
      overrides.followupRun ??
      createTestFollowupRun({ sessionId: "session", sessionFile, sessionKey });
    return await runSessionCompactionIfNeeded({
      followupRun,
      defaultModel,
      sessionEntry,
      sessionStore: { [overrides.sessionKey ?? sessionKey]: sessionEntry },
      sessionKey,
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      abortSignal: new AbortController().signal,
      ...overrides,
      cfg: withTestModelContextTokens({
        cfg: overrides.cfg ?? { agents: { defaults: { compaction } } },
        followupRun,
        defaultModel,
        contextTokens: 100_000,
      }),
    });
  }

  async function writeFreshEntry(key = sessionKey) {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(2_000) } })}\n`,
      "utf8",
    );
    const sessionEntry = createFreshSessionEntry({ sessionFile, totalTokens: 200_000 });
    await writeTestSessionStore(path.join(rootDir, "sessions.json"), key, sessionEntry);
    return { sessionEntry, sessionFile };
  }

  it("compacts fresh token totals above the model budget", async () => {
    const { sessionEntry, sessionFile } = await writeFreshEntry();
    await runWithEntry(sessionEntry, sessionFile);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["an embedded provider", "anthropic", "claude-opus-4-6", true],
    ["provider runtime selection", "openai", "gpt-5.6-luna", false],
  ] as const)(
    "resolves an unscoped session key with the sole configured agent for %s",
    async (_name, provider, model, expectsCompaction) => {
      const { sessionEntry, sessionFile } = await writeFreshEntry("main");
      const result = await runWithEntry(sessionEntry, sessionFile, {
        cfg: { agents: { entries: { ops: {} }, defaults: { compaction } } },
        followupRun: createTestFollowupRun({
          agentId: undefined,
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
          provider,
          model,
        }),
        sessionKey: "main",
      });

      expect(result).toBe(sessionEntry);
      if (expectsCompaction) {
        expect(compactEmbeddedAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
          sessionTarget: { agentId: "ops" },
        });
      } else {
        expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      }
    },
  );

  it("excludes superseded oversized history from the active context budget", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createSessionEntry({ totalTokensFresh: false });
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, sessionEntry);
    const transcript = SessionManager.open(scope, rootDir);
    transcript.appendMessage(makeUserMessage("superseded history ".repeat(25_000), 1));
    const retained = transcript.appendMessage(makeUserMessage("keep", 2));
    transcript.appendCompaction("Short summary", retained, 100_000);
    transcript.appendMessage(makeUserMessage("latest", 3));
    await runWithEntry(sessionEntry, path.join(rootDir, "session.jsonl"));
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });
});
