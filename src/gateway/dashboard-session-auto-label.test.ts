/** Tests dashboard session auto-label helpers and scheduling. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateConversationLabel = vi.hoisted(() => vi.fn());
const updateSessionStore = vi.hoisted(() => vi.fn());
const emitSessionsChanged = vi.hoisted(() => vi.fn());
const logVerbose = vi.hoisted(() => vi.fn());

vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabel,
}));

vi.mock("../config/sessions.js", () => ({
  updateSessionStore,
}));

vi.mock("./server-methods/session-change-event.js", () => ({
  emitSessionsChanged,
}));

vi.mock("../globals.js", () => ({
  logVerbose,
}));

import {
  DASHBOARD_SESSION_AUTO_LABEL_MAX_LENGTH,
  isDashboardSessionKey,
  scheduleDashboardSessionAutoLabel,
  shouldAutoLabelDashboardSession,
} from "./dashboard-session-auto-label.js";

describe("isDashboardSessionKey", () => {
  it("matches Control UI dashboard session keys", () => {
    expect(isDashboardSessionKey("agent:main:dashboard:93a9f0e2-1234-5678-9abc-def012345678")).toBe(
      true,
    );
  });

  it("rejects non-dashboard keys", () => {
    expect(isDashboardSessionKey("agent:main:main")).toBe(false);
    expect(isDashboardSessionKey("agent:main:telegram:direct:user123")).toBe(false);
    expect(isDashboardSessionKey("agent:ops-agent:dashboard:direct:subagent-orchestrator")).toBe(
      false,
    );
  });
});

describe("shouldAutoLabelDashboardSession", () => {
  it("requires dashboard key, empty label, and user text", () => {
    expect(
      shouldAutoLabelDashboardSession({
        sessionKey: "agent:main:dashboard:abc",
        entry: { sessionId: "sess", updatedAt: 1 },
        userMessage: "hello",
      }),
    ).toBe(true);
    expect(
      shouldAutoLabelDashboardSession({
        sessionKey: "agent:main:main",
        entry: { sessionId: "sess", updatedAt: 1 },
        userMessage: "hello",
      }),
    ).toBe(false);
    expect(
      shouldAutoLabelDashboardSession({
        sessionKey: "agent:main:dashboard:abc",
        entry: { sessionId: "sess", updatedAt: 1, label: "Existing" },
        userMessage: "hello",
      }),
    ).toBe(false);
    expect(
      shouldAutoLabelDashboardSession({
        sessionKey: "agent:main:dashboard:abc",
        entry: { sessionId: "sess", updatedAt: 1 },
        userMessage: "   ",
      }),
    ).toBe(false);
  });
});

describe("scheduleDashboardSessionAutoLabel", () => {
  beforeEach(() => {
    generateConversationLabel.mockReset();
    updateSessionStore.mockReset();
    emitSessionsChanged.mockReset();
    logVerbose.mockReset();
    generateConversationLabel.mockResolvedValue("Car rental refund");
    updateSessionStore.mockImplementation(async (_storePath, mutator) =>
      mutator({
        "agent:main:dashboard:abc": {
          sessionId: "sess",
          updatedAt: 1,
        },
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates and persists a label for unlabeled dashboard sessions", async () => {
    scheduleDashboardSessionAutoLabel({
      cfg: {} as never,
      context: {
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(),
      },
      sessionKey: "agent:main:dashboard:abc",
      agentId: "main",
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess", updatedAt: 1 },
      userMessage: "If I return a rental car early, do I get a refund?",
    });

    await vi.waitFor(() => {
      expect(generateConversationLabel).toHaveBeenCalledTimes(1);
      expect(updateSessionStore).toHaveBeenCalledTimes(1);
      expect(emitSessionsChanged).toHaveBeenCalledTimes(1);
    });

    expect(generateConversationLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "If I return a rental car early, do I get a refund?",
        maxLength: DASHBOARD_SESSION_AUTO_LABEL_MAX_LENGTH,
      }),
    );
    expect(emitSessionsChanged).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:abc",
        agentId: "main",
        reason: "patch",
      }),
    );
  });

  it("skips labeled sessions without calling the LLM", async () => {
    scheduleDashboardSessionAutoLabel({
      cfg: {} as never,
      context: {
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(),
      },
      sessionKey: "agent:main:dashboard:abc",
      agentId: "main",
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess", updatedAt: 1, label: "Existing title" },
      userMessage: "hello",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(generateConversationLabel).not.toHaveBeenCalled();
    expect(updateSessionStore).not.toHaveBeenCalled();
  });
});
