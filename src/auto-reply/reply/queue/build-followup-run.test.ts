import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));
vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));
vi.mock("../../../agents/agent-scope.js", () => ({
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));
vi.mock("../../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(),
}));
vi.mock("../../../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: vi.fn(),
}));
vi.mock("../../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(),
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));
vi.mock("../../../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: vi.fn().mockReturnValue(false),
}));
vi.mock("../../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../../agents/timeout.js";
import { loadConfig } from "../../../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "../../../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { buildFollowupRunForSession } from "./build-followup-run.js";

const SESSION_KEY = "agent:main:telegram:direct:123";

function makeCfg() {
  return { session: { store: "/tmp/store" } } as ReturnType<typeof loadConfig>;
}

function makeSessionEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-abc",
    updatedAt: Date.now(),
    lastChannel: "telegram",
    lastTo: "123",
    lastAccountId: "acc-1",
    lastThreadId: 456,
    chatType: "direct" as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockReturnValue(makeCfg());
  vi.mocked(resolveStorePath).mockReturnValue("/tmp/store/main");
  vi.mocked(resolveAgentDir).mockReturnValue("/tmp/agents/main");
  vi.mocked(resolveAgentWorkspaceDir).mockReturnValue("/tmp/workspace");
  vi.mocked(resolveAgentTimeoutMs).mockReturnValue(300_000);
  vi.mocked(resolveAgentIdFromSessionKey).mockReturnValue("main");
  vi.mocked(resolveDefaultModelForAgent).mockReturnValue({
    provider: "anthropic",
    model: "claude-opus-4-6",
  } as ReturnType<typeof resolveDefaultModelForAgent>);
  vi.mocked(resolveSessionFilePath).mockReturnValue("/tmp/store/main/session-abc.jsonl");
  vi.mocked(resolveSessionFilePathOptions).mockReturnValue({
    agentId: "main",
    sessionsDir: "/tmp/store",
  });
});

describe("buildFollowupRunForSession", () => {
  it("returns null when session key not found", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result).toBeNull();
  });

  it("populates provider/model from session overrides", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4o",
      }),
    });
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result).not.toBeNull();
    expect(result?.run.provider).toBe("openai");
    expect(result?.run.model).toBe("gpt-4o");
  });

  it("falls back to agent defaults when no session overrides", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry(),
    });
    vi.mocked(resolveDefaultModelForAgent).mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    } as ReturnType<typeof resolveDefaultModelForAgent>);
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result?.run.provider).toBe("anthropic");
    expect(result?.run.model).toBe("claude-sonnet-4-6");
  });

  it("resolves delivery context from session entry", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry({
        lastChannel: "telegram",
        lastTo: "456",
        lastAccountId: "acc-2",
        lastThreadId: 789,
        chatType: "group",
      }),
    });
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result?.originatingChannel).toBe("telegram");
    expect(result?.originatingTo).toBe("456");
    expect(result?.originatingAccountId).toBe("acc-2");
    expect(result?.originatingThreadId).toBe(789);
    expect(result?.originatingChatType).toBe("group");
  });

  it("prefers params delivery context over session entry", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry(),
    });
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
      originatingChannel: "discord",
      originatingTo: "param-to",
      originatingAccountId: "param-acc",
      originatingThreadId: 99,
      originatingChatType: "group",
    });
    expect(result?.originatingChannel).toBe("discord");
    expect(result?.originatingTo).toBe("param-to");
    expect(result?.originatingAccountId).toBe("param-acc");
    expect(result?.originatingThreadId).toBe(99);
    expect(result?.originatingChatType).toBe("group");
  });

  it("populates auth profile from session entry", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry({
        authProfileOverride: "profile-x",
        authProfileOverrideSource: "user",
      }),
    });
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result?.run.authProfileId).toBe("profile-x");
    expect(result?.run.authProfileIdSource).toBe("user");
  });

  it("always sets senderIsOwner to true", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry(),
    });
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result?.run.senderIsOwner).toBe(true);
  });

  it("propagates session runtime levels", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry({
        thinkingLevel: "high",
        verboseLevel: "verbose",
        reasoningLevel: "on",
        elevatedLevel: "on",
      }),
    });
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result?.run.thinkLevel).toBe("high");
    expect(result?.run.verboseLevel).toBe("verbose");
    expect(result?.run.reasoningLevel).toBe("on");
    expect(result?.run.elevatedLevel).toBe("on");
  });

  it("uses sessionFile from entry when present", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry({
        sessionFile: "/custom/path/session.jsonl",
      }),
    });
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result?.run.sessionFile).toBe("/custom/path/session.jsonl");
  });

  it("falls back to resolveSessionFilePath when no sessionFile", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry(),
    });
    vi.mocked(resolveSessionFilePath).mockReturnValue("/fallback/session.jsonl");
    const result = await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });
    expect(result?.run.sessionFile).toBe("/fallback/session.jsonl");
  });

  it("passes store path to resolveSessionFilePathOptions for correct fallback dir", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      [SESSION_KEY]: makeSessionEntry(),
    });
    vi.mocked(resolveStorePath).mockReturnValue("/custom/store/main");
    vi.mocked(resolveSessionFilePathOptions).mockReturnValue({
      agentId: "main",
      sessionsDir: "/custom/store",
    });
    vi.mocked(resolveSessionFilePath).mockReturnValue("/custom/store/session-abc.jsonl");

    await buildFollowupRunForSession({
      sessionKey: SESSION_KEY,
      prompt: "hello",
    });

    expect(resolveSessionFilePathOptions).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/custom/store/main",
    });
    expect(resolveSessionFilePath).toHaveBeenCalledWith("session-abc", expect.anything(), {
      agentId: "main",
      sessionsDir: "/custom/store",
    });
  });
});
