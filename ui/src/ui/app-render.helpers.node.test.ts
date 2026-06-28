// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const {
  refreshChatMock,
  refreshChatAvatarMock,
  flushChatQueueAfterIdleSessionReconciliationMock,
  refreshSlashCommandsMock,
  loadChatHistoryMock,
  scheduleChatScrollMock,
  sessionsRefreshMock,
  sessionsSubscribeMessagesMock,
} = vi.hoisted(() => ({
  refreshChatMock: vi.fn(),
  refreshChatAvatarMock: vi.fn(),
  flushChatQueueAfterIdleSessionReconciliationMock: vi.fn(),
  refreshSlashCommandsMock: vi.fn(),
  loadChatHistoryMock: vi.fn(),
  scheduleChatScrollMock: vi.fn(),
  sessionsRefreshMock: vi.fn(async () => undefined),
  sessionsSubscribeMessagesMock: vi.fn(
    async (key: string, options?: { agentId?: string | null }) => ({
      key,
      agentId: options?.agentId ?? null,
    }),
  ),
}));

vi.mock("../pages/chat/data.ts", () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 120,
  CHAT_SESSIONS_REFRESH_LIMIT: 50,
  createChatSessionsLoadOverrides: () => ({
    activeMinutes: 120,
    limit: 50,
    includeGlobal: true,
    includeUnknown: true,
    showArchived: false,
  }),
  scopedAgentParamsForSession: (state: unknown, sessionKey: string) => {
    if (sessionKey === "global") {
      return {
        agentId: (state as { assistantAgentId?: string | null }).assistantAgentId ?? "main",
      };
    }
    const [, agentId] = sessionKey.split(":");
    return sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
  scopedAgentListParamsForSession: (state: unknown, sessionKey: string) => {
    if (sessionKey === "global") {
      return {
        agentId: (state as { assistantAgentId?: string | null }).assistantAgentId ?? "main",
      };
    }
    if (sessionKey === "unknown") {
      return {};
    }
    const [, agentId] = sessionKey.split(":");
    return sessionKey.startsWith("agent:") && agentId ? { agentId } : { agentId: "main" };
  },
  refreshChat: refreshChatMock,
  refreshChatAvatar: refreshChatAvatarMock,
  flushChatQueueAfterIdleSessionReconciliation: flushChatQueueAfterIdleSessionReconciliationMock,
}));

vi.mock("./chat/slash-commands.ts", () => ({
  refreshSlashCommands: (...args: unknown[]) => refreshSlashCommandsMock(...args),
}));

vi.mock("../pages/chat/gateway.ts", () => ({
  loadChatHistory: loadChatHistoryMock,
  syncSelectedSessionMessageSubscription: async (state: {
    sessionKey: string;
    sessions: {
      subscribeMessages: (key: string) => Promise<{ key: string; agentId: string | null }>;
    };
    chatSessionMessageSubscriptionRequestedKey?: string | null;
    chatSessionMessageSubscriptionKey?: string | null;
    chatSessionMessageSubscriptionAgentId?: string | null;
  }) => {
    const subscription = await state.sessions.subscribeMessages(state.sessionKey);
    state.chatSessionMessageSubscriptionRequestedKey = state.sessionKey;
    state.chatSessionMessageSubscriptionKey = subscription.key;
    state.chatSessionMessageSubscriptionAgentId = subscription.agentId;
  },
}));

vi.mock("../pages/chat/scroll.ts", () => ({
  scheduleChatScroll: scheduleChatScrollMock,
}));

vi.mock("../pages/chat/chat-avatar.ts", () => ({
  refreshChatAvatar: refreshChatAvatarMock,
}));

import type { SessionsListResult } from "../api/types.ts";
import {
  isCronSessionKey,
  parseSessionKey,
  resolveSessionDisplayName,
} from "../lib/session-display.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { switchChatSession, switchChatSessionAndWait } from "../pages/chat/session-switch.ts";
import { resolveDashboardHeaderContext } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import { resolveSessionOptionGroups } from "./chat/session-controls.ts";

type SessionRow = SessionsListResult["sessions"][number];

beforeEach(() => {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      callback(0);
      return 0;
    });
  }
  refreshChatMock.mockReset();
  refreshChatAvatarMock.mockReset();
  flushChatQueueAfterIdleSessionReconciliationMock.mockReset();
  refreshSlashCommandsMock.mockReset();
  loadChatHistoryMock.mockReset();
  scheduleChatScrollMock.mockReset();
  sessionsRefreshMock.mockReset();
  sessionsSubscribeMessagesMock.mockReset();
  sessionsSubscribeMessagesMock.mockImplementation(
    async (key: string, options?: { agentId?: string | null }) => ({
      key,
      agentId: options?.agentId ?? null,
    }),
  );
});

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

function labelsForSessionOptions(params: {
  sessionKey: string;
  sessions?: SessionRow[];
  agentsList?: AppViewState["agentsList"];
}) {
  const groups = resolveSessionOptionGroups(
    {
      sessionsHideCron: true,
      agentsList: params.agentsList ?? null,
    } as AppViewState,
    params.sessionKey,
    {
      ts: 0,
      path: "",
      count: params.sessions?.length ?? 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: params.sessions ?? [],
    },
  );
  return groups.flatMap((group) => group.options.map((option) => option.label));
}

function createSettings(): AppViewState["settings"] {
  return {
    gatewayUrl: "",
    token: "",
    locale: "en",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "dark",
    splitRatio: 0.6,
    navWidth: 280,
    navCollapsed: false,
    navGroupsCollapsed: {},
    borderRadius: 50,
    chatShowThinking: false,
    chatShowToolCalls: true,
  };
}

function withSessionCapability<T extends object>(state: T): T & { sessions: SessionCapability } {
  return Object.assign(state, {
    basePath: (state as { basePath?: string }).basePath ?? "",
    updateComplete:
      (state as { updateComplete?: Promise<unknown> }).updateComplete ?? Promise.resolve(),
    sessions: {
      state: { modelOverrides: {} },
      refresh: sessionsRefreshMock,
      subscribeMessages: sessionsSubscribeMessagesMock,
    } as unknown as SessionCapability,
  });
}

function createChatSwitchState(overrides: Partial<AppViewState> = {}) {
  const settings = createSettings();
  const state = {
    sessionKey: "agent:ops:main",
    chatMessage: "draft prompt",
    chatAttachments: [{ id: "att-1", mimeType: "image/png", dataUrl: "data:image/png;base64,AAA" }],
    chatMessages: [{ role: "assistant", content: "old" }],
    chatToolMessages: [{ id: "tool-1" }],
    chatStreamSegments: [],
    chatThinkingLevel: null,
    chatStream: null,
    chatSideResult: null,
    lastError: null,
    compactionStatus: null,
    fallbackStatus: null,
    chatAvatarUrl: null,
    chatAvatarSource: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatLoading: false,
    chatSideResultTerminalRuns: new Set<string>(),
    chatStreamStartedAt: null,
    connected: true,
    client: { request: vi.fn() },
    sessionsLoading: false,
    sessionsError: null,
    sessionsShowArchived: false,
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [row({ key: "agent:ops:main" })],
    },
    settings,
    applySettings(next: typeof settings) {
      state.settings = next;
    },
    loadAssistantIdentity: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
    resetChatInputHistoryNavigation: vi.fn(),
    ...overrides,
  } as unknown as AppViewState;
  return withSessionCapability(state);
}

/* ================================================================
 *  parseSessionKey – low-level key → type / fallback mapping
 * ================================================================ */

describe("parseSessionKey", () => {
  it("identifies main session (bare 'main')", () => {
    expect(parseSessionKey("main")).toEqual({ prefix: "", fallbackName: "Main Session" });
  });

  it("identifies main session (agent:main:main)", () => {
    expect(parseSessionKey("agent:main:main")).toEqual({
      prefix: "",
      fallbackName: "Main Session",
    });
  });

  it("identifies subagent sessions", () => {
    expect(parseSessionKey("agent:main:subagent:18abfefe-1fa6-43cb-8ba8-ebdc9b43e253")).toEqual({
      prefix: "Subagent:",
      fallbackName: "Subagent:",
    });
  });

  it("identifies cron sessions", () => {
    expect(parseSessionKey("agent:main:cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
    expect(parseSessionKey("cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
  });

  it("identifies direct chat with known channel", () => {
    expect(parseSessionKey("agent:main:imessage:direct:+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage · +19257864429",
    });
  });

  it("identifies direct chat with telegram", () => {
    expect(parseSessionKey("agent:main:telegram:direct:user123")).toEqual({
      prefix: "",
      fallbackName: "Telegram · user123",
    });
  });

  it("identifies group chat with known channel", () => {
    expect(parseSessionKey("agent:main:discord:group:guild-chan")).toEqual({
      prefix: "",
      fallbackName: "Discord Group",
    });
  });

  it("capitalises unknown channels in direct/group patterns", () => {
    expect(parseSessionKey("agent:main:mychannel:direct:user1")).toEqual({
      prefix: "",
      fallbackName: "Mychannel · user1",
    });
  });

  it("identifies channel-prefixed legacy keys", () => {
    expect(parseSessionKey("imessage:g-agent-main-imessage-direct-+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage Session",
    });
    expect(parseSessionKey("discord:123:456")).toEqual({
      prefix: "",
      fallbackName: "Discord Session",
    });
  });

  it("handles bare channel name as key", () => {
    expect(parseSessionKey("telegram")).toEqual({
      prefix: "",
      fallbackName: "Telegram Session",
    });
  });

  it("returns raw key for unknown parse patterns", () => {
    expect(parseSessionKey("something-unknown")).toEqual({
      prefix: "",
      fallbackName: "something-unknown",
    });
  });
});

/* ================================================================
 *  resolveSessionDisplayName – full resolution with row data
 * ================================================================ */

describe("resolveSessionDisplayName", () => {
  // ── Key-only fallbacks (no row) ──────────────────

  it("returns 'Main Session' for agent:main:main key", () => {
    expect(resolveSessionDisplayName("agent:main:main")).toBe("Main Session");
  });

  it("returns 'Main Session' for bare 'main' key", () => {
    expect(resolveSessionDisplayName("main")).toBe("Main Session");
  });

  it("returns 'Subagent:' for subagent key without row", () => {
    expect(resolveSessionDisplayName("agent:main:subagent:abc-123")).toBe("Subagent:");
  });

  it("returns 'Cron Job:' for cron key without row", () => {
    expect(resolveSessionDisplayName("agent:main:cron:abc-123")).toBe("Cron Job:");
  });

  it("parses direct chat key with channel", () => {
    expect(resolveSessionDisplayName("agent:main:imessage:direct:+19257864429")).toBe(
      "iMessage · +19257864429",
    );
  });

  it("parses channel-prefixed legacy key", () => {
    expect(resolveSessionDisplayName("discord:123:456")).toBe("Discord Session");
  });

  it("returns raw key for unknown display-name patterns", () => {
    expect(resolveSessionDisplayName("something-custom")).toBe("something-custom");
  });

  // ── With row data (label / displayName) ──────────

  it("returns parsed fallback when row has no label or displayName", () => {
    expect(resolveSessionDisplayName("agent:main:main", row({ key: "agent:main:main" }))).toBe(
      "Main Session",
    );
  });

  it("returns parsed fallback when displayName matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", displayName: "mykey" }))).toBe(
      "mykey",
    );
  });

  it("returns parsed fallback when label matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", label: "mykey" }))).toBe("mykey");
  });

  it("uses label alone when available", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", label: "General" }),
      ),
    ).toBe("General");
  });

  it("falls back to displayName when label is absent", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat" }),
      ),
    ).toBe("My Chat");
  });

  it("prefers label over displayName when both are present", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "General" }),
      ),
    ).toBe("General");
  });

  it("ignores whitespace-only label and falls back to displayName", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "   " }),
      ),
    ).toBe("My Chat");
  });

  it("uses parsed fallback when whitespace-only label and no displayName", () => {
    expect(
      resolveSessionDisplayName("discord:123:456", row({ key: "discord:123:456", label: "   " })),
    ).toBe("Discord Session");
  });

  it("trims label and displayName", () => {
    expect(resolveSessionDisplayName("k", row({ key: "k", label: "  General  " }))).toBe("General");
    expect(resolveSessionDisplayName("k", row({ key: "k", displayName: "  My Chat  " }))).toBe(
      "My Chat",
    );
  });

  // ── Type prefixes applied to labels / displayNames ──

  it("prefixes subagent label with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", label: "maintainer-v2" }),
      ),
    ).toBe("Subagent: maintainer-v2");
  });

  it("prefixes subagent displayName with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Task Runner" }),
      ),
    ).toBe("Subagent: Task Runner");
  });

  it("prefixes cron label with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "daily-briefing" }),
      ),
    ).toBe("Cron: daily-briefing");
  });

  it("prefixes cron displayName with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", displayName: "Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix cron labels that already include Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "Cron: Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix subagent display names that already include Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Subagent: Runner" }),
      ),
    ).toBe("Subagent: Runner");
  });

  it("does not prefix non-typed sessions with labels", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:imessage:direct:+19257864429",
        row({ key: "agent:main:imessage:direct:+19257864429", label: "Tyler" }),
      ),
    ).toBe("Tyler");
  });
});

describe("resolveDashboardHeaderContext", () => {
  it("uses the active agent identity name", () => {
    expect(
      resolveDashboardHeaderContext({
        sessionKey: "agent:deep-chat:imessage:sample-thread",
        agentsList: {
          defaultId: "deep-chat",
          mainKey: "main",
          scope: "user",
          agents: [{ id: "deep-chat", identity: { name: "Deep Chat" } }],
        },
      } as unknown as AppViewState),
    ).toEqual({ agentLabel: "Deep Chat" });
  });

  it("falls back to the configured agent name", () => {
    expect(
      resolveDashboardHeaderContext({
        sessionKey: "agent:beta:main",
        agentsList: {
          defaultId: "beta",
          mainKey: "main",
          scope: "user",
          agents: [{ id: "beta", name: "Coding" }],
        },
      } as unknown as AppViewState),
    ).toEqual({ agentLabel: "Coding" });
  });

  it("falls back to the agent id", () => {
    expect(
      resolveDashboardHeaderContext({
        sessionKey: "agent:beta:subagent:maintainer-v2",
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "user",
          agents: [],
        },
      } as unknown as AppViewState),
    ).toEqual({ agentLabel: "beta" });
  });
});

describe("isCronSessionKey", () => {
  it("returns true for cron: prefixed keys", () => {
    expect(isCronSessionKey("cron:abc-123")).toBe(true);
    expect(isCronSessionKey("cron:weekly-agent-roundtable")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123:run:run-1")).toBe(true);
  });

  it("returns false for non-cron keys", () => {
    expect(isCronSessionKey("main")).toBe(false);
    expect(isCronSessionKey("discord:group:eng")).toBe(false);
    expect(isCronSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
  });
});

describe("resolveSessionOptionGroups", () => {
  it("prefers grouped session labels over display names", () => {
    const sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    const labels = labelsForSessionOptions({
      sessionKey,
      sessions: [
        row({
          key: sessionKey,
          label: "cron-config-check",
          displayName: "webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
        }),
      ],
    });

    expect(labels).toEqual(["Subagent: cron-config-check"]);
  });

  it("keeps the active subagent session visible when no row exists yet", () => {
    const sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";

    expect(labelsForSessionOptions({ sessionKey })).toEqual([
      "subagent:4f2146de-887b-4176-9abe-91140082959b",
    ]);
    expect(
      labelsForSessionOptions({
        sessionKey,
        sessions: [row({ key: sessionKey })],
      }),
    ).toEqual(["subagent:4f2146de-887b-4176-9abe-91140082959b"]);
  });

  it("keeps the active agent main session visible when no row exists yet", () => {
    expect(labelsForSessionOptions({ sessionKey: "agent:main:main" })).toEqual(["main"]);
  });

  it("hides inactive subagent sessions from the picker", () => {
    const labels = labelsForSessionOptions({
      sessionKey: "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
      sessions: [
        row({
          key: "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
          label: "cron-config-check",
        }),
        row({
          key: "agent:main:subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
          label: "cron-config-check",
        }),
      ],
    });

    expect(labels).toEqual(["Subagent: cron-config-check"]);
  });

  it("filters the chat session options to the active agent", () => {
    const labels = labelsForSessionOptions({
      sessionKey: "agent:alpha:main",
      agentsList: {
        defaultId: "alpha",
        mainKey: "agent:alpha:main",
        scope: "all",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "beta", name: "Coding" },
        ],
      },
      sessions: [
        row({ key: "agent:alpha:main" }),
        row({ key: "agent:beta:main" }),
        row({
          key: "agent:alpha:named-main",
          label: "Deep Chat (alpha) / main",
        }),
      ],
    });

    expect(labels).toEqual(["main", "Deep Chat (alpha) / main"]);
  });

  it("shows sessions for the selected agent after switching agent scope", () => {
    const labels = labelsForSessionOptions({
      sessionKey: "agent:beta:main",
      agentsList: {
        defaultId: "alpha",
        mainKey: "agent:alpha:main",
        scope: "all",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "beta", name: "Coding" },
        ],
      },
      sessions: [
        row({ key: "agent:alpha:main" }),
        row({ key: "agent:beta:main" }),
        row({ key: "agent:beta:dashboard:recent", label: "Bug triage" }),
      ],
    });

    expect(labels).toEqual(["main", "Bug triage"]);
  });

  it("keeps bare legacy sessions scoped to the default agent only", () => {
    const labels = labelsForSessionOptions({
      sessionKey: "agent:beta:main",
      agentsList: {
        defaultId: "alpha",
        mainKey: "agent:alpha:main",
        scope: "all",
        agents: [
          { id: "alpha", name: "Deep Chat" },
          { id: "beta", name: "Coding" },
        ],
      },
      sessions: [
        row({ key: "main", label: "Legacy main" }),
        row({ key: "agent:alpha:main", label: "Alpha main" }),
        row({ key: "agent:beta:main", label: "Beta main" }),
      ],
    });

    expect(labels).toEqual(["Beta main"]);
  });

  it("hides spawned subagent sessions under their parent", () => {
    const parentKey = "agent:main:main";
    const subagentKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    const labels = labelsForSessionOptions({
      sessionKey: parentKey,
      sessions: [
        row({ key: parentKey, label: "Spock" }),
        row({ key: subagentKey, label: "PLC Coder", spawnedBy: parentKey }),
      ],
    });

    expect(labels).toEqual(["Spock"]);
  });

  it("keeps the active subagent session visible without nesting it", () => {
    const parentKey = "agent:main:main";
    const subagentKey = "agent:main:subagent:f4ac7ef1-1234-5678-9abc-def012345678";
    const labels = labelsForSessionOptions({
      sessionKey: subagentKey,
      sessions: [
        row({ key: parentKey, label: "Spock" }),
        row({ key: subagentKey, label: "PLC Coder", spawnedBy: parentKey }),
      ],
    });

    expect(labels).toEqual(["Spock", "Subagent: PLC Coder"]);
  });

  it("hides spawned subagent siblings regardless of row order", () => {
    const parentKey = "agent:main:main";
    const newerSubagentKey = "agent:main:subagent:newer";
    const olderSubagentKey = "agent:main:subagent:older";
    const labels = labelsForSessionOptions({
      sessionKey: parentKey,
      sessions: [
        row({ key: newerSubagentKey, label: "Newer", spawnedBy: parentKey }),
        row({ key: olderSubagentKey, label: "Older", spawnedBy: parentKey }),
        row({ key: parentKey, label: "Spock" }),
      ],
    });

    expect(labels).toEqual(["Spock"]);
  });
});

describe("switchChatSession", () => {
  it("waits for the initial history and message subscription when requested", async () => {
    let resolveHistory!: () => void;
    let resolveSubscription!: () => void;
    const historyLoaded = new Promise<void>((resolve) => {
      resolveHistory = resolve;
    });
    const subscriptionSynced = new Promise<void>((resolve) => {
      resolveSubscription = resolve;
    });
    const settings = createSettings();
    const state = withSessionCapability({
      sessionKey: "main",
      connected: true,
      client: { request: vi.fn() },
      chatMessage: "",
      chatAttachments: [],
      chatMessages: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatQueueBySession: {},
      chatRunId: null,
      sessionsShowArchived: false,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: null,
      sessionsResult: {
        ts: 0,
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [row({ key: "main" }), row({ key: "agent:main:review" })],
      },
      settings,
      announceSessionSwitch: vi.fn(),
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      resetChatInputHistoryNavigation: vi.fn(),
    } as unknown as AppViewState);

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockReturnValue(historyLoaded);
    sessionsSubscribeMessagesMock.mockReturnValue(
      subscriptionSynced.then(() => ({ key: "agent:main:review", agentId: "main" })),
    );

    const switched = switchChatSessionAndWait(state, "agent:main:review");
    let settled = false;
    void switched.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveHistory();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSubscription();
    await switched;

    expect(settled).toBe(true);
    expect(state.sessionKey).toBe("agent:main:review");
  });

  it("refreshes the chat avatar after clearing session-scoped state", async () => {
    const settings = createSettings();
    const state = withSessionCapability({
      sessionKey: "main",
      chatMessage: "draft",
      chatAttachments: [
        { id: "att-1", mimeType: "image/png", dataUrl: "data:image/png;base64,AAA" },
      ],
      chatMessages: [{ role: "assistant", content: "old" }],
      chatToolMessages: [{ id: "tool-1" }],
      chatStreamSegments: [{ text: "segment", ts: 1 }],
      chatThinkingLevel: "high",
      chatVerboseLevel: "full",
      chatStream: "stream",
      chatSideResult: {
        kind: "btw",
        runId: "btw-run-1",
        sessionKey: "main",
        question: "what changed?",
        text: "draft answer",
        isError: false,
        ts: 1,
      },
      lastError: "oops",
      compactionStatus: { phase: "active" },
      fallbackStatus: { phase: "active" },
      chatAvatarUrl: "/avatar/old",
      chatQueue: [{ id: "queued", text: "message B", createdAt: 1 }],
      chatQueueBySession: {},
      chatRunId: "run-1",
      sessionsShowArchived: false,
      chatSideResultTerminalRuns: new Set(["btw-run-1"]),
      chatStreamStartedAt: 1,
      sessionsResult: {
        ts: 0,
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          row({ key: "main" }),
          row({ key: "agent:main:test-b", label: "Review Session" }),
        ],
      },
      settings,
      announceSessionSwitch: vi.fn(),
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      resetChatInputHistoryNavigation: vi.fn(),
    } as unknown as AppViewState);

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);

    switchChatSession(state, "agent:main:test-b");
    await Promise.resolve();

    expect(state.chatQueue).toStrictEqual([]);
    expect(state.chatQueueBySession.main).toEqual([
      { id: "queued", text: "message B", createdAt: 1 },
    ]);
    expect(state.chatSideResult).toBeNull();
    expect(state.chatSideResultTerminalRuns.size).toBe(0);
    expect(
      (state as unknown as { resetChatInputHistoryNavigation: ReturnType<typeof vi.fn> })
        .resetChatInputHistoryNavigation,
    ).toHaveBeenCalled();
    expect(refreshChatAvatarMock).toHaveBeenCalledWith(state);
    expect(refreshSlashCommandsMock).toHaveBeenCalledWith({
      client: undefined,
      agentId: "main",
    });
    expect(loadChatHistoryMock).toHaveBeenCalledWith(state);
    expect(sessionsRefreshMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", force: true }),
    );
    expect(
      (state as unknown as { announceSessionSwitch: ReturnType<typeof vi.fn> })
        .announceSessionSwitch,
    ).toHaveBeenCalledWith("agent:main:test-b", "Review Session");
  });

  it("restores queued messages when switching back to their session", () => {
    const settings = createSettings();
    const state = withSessionCapability({
      sessionKey: "main",
      chatMessage: "",
      chatAttachments: [],
      chatMessages: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      chatStream: "stream",
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [{ id: "queued-1", text: "message B", createdAt: 1 }],
      chatQueueBySession: {},
      chatRunId: "run-1",
      sessionsShowArchived: false,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: 1,
      settings,
      announceSessionSwitch: vi.fn(),
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      resetChatInputHistoryNavigation: vi.fn(),
    } as unknown as AppViewState);

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);

    switchChatSession(state, "agent:main:other");
    expect(state.chatQueue).toStrictEqual([]);

    switchChatSession(state, "main");

    expect(state.chatQueue).toEqual([{ id: "queued-1", text: "message B", createdAt: 1 }]);
  });

  it("passes restored queued messages through idle reconciliation after switching back", () => {
    const queuedMessage = { id: "queued-1", text: "message B", createdAt: 1 };
    const state = createChatSwitchState({
      sessionKey: "main",
      chatMessage: "",
      chatAttachments: [],
      chatQueue: [queuedMessage],
      chatRunId: "run-1",
      chatStream: "stream",
      sessionsResult: {
        ts: 0,
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          row({ key: "main", hasActiveRun: true, status: "running" }),
          row({ key: "agent:main:other", hasActiveRun: false, status: "done" }),
        ],
      },
    });
    const reconciliationCalls: Array<{ sessionKey: string; queue: unknown[] }> = [];
    flushChatQueueAfterIdleSessionReconciliationMock.mockImplementation((host, sessionKey) => {
      reconciliationCalls.push({
        sessionKey: String(sessionKey),
        queue: [...((host as { chatQueue?: unknown[] }).chatQueue ?? [])],
      });
    });
    loadChatHistoryMock
      .mockResolvedValueOnce({
        messages: [],
        sessionInfo: row({ key: "agent:main:other", hasActiveRun: false, status: "done" }),
      })
      .mockResolvedValueOnce({
        messages: [],
        sessionInfo: row({ key: "main", hasActiveRun: false, status: "done" }),
      });
    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);

    switchChatSession(state, "agent:main:other");
    expect(state.chatQueue).toStrictEqual([]);

    state.sessionsResult = {
      ...state.sessionsResult!,
      sessions: [
        row({ key: "main", hasActiveRun: false, status: "done" }),
        row({ key: "agent:main:other", hasActiveRun: false, status: "done" }),
      ],
    };

    switchChatSession(state, "main");

    expect(state.chatQueue).toEqual([queuedMessage]);
    expect(reconciliationCalls).toEqual([
      { sessionKey: "agent:main:other", queue: [] },
      { sessionKey: "main", queue: [queuedMessage] },
    ]);
  });

  it("does not force agentId=main for plain session keys", async () => {
    const settings = createSettings();
    const state = withSessionCapability({
      sessionKey: "main",
      chatMessage: "",
      chatAttachments: [],
      chatMessages: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatQueueBySession: {},
      chatRunId: null,
      sessionsShowArchived: false,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: null,
      settings,
      announceSessionSwitch: vi.fn(),
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      resetChatInputHistoryNavigation: vi.fn(),
      client: { request: vi.fn() },
    } as unknown as AppViewState);

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);

    switchChatSession(state, "main");
    await Promise.resolve();

    expect(
      (state as unknown as { announceSessionSwitch: ReturnType<typeof vi.fn> })
        .announceSessionSwitch,
    ).not.toHaveBeenCalled();
    expect(refreshSlashCommandsMock).toHaveBeenCalledWith({
      client: state.client,
      agentId: undefined,
    });
  });

  it("restores visible messages when switching back before history reloads", () => {
    const mainMessages = [{ role: "assistant", content: [{ type: "text", text: "main report" }] }];
    const otherMessages = [{ role: "assistant", content: [{ type: "text", text: "other reply" }] }];
    const settings = createSettings();
    const state = withSessionCapability({
      sessionKey: "main",
      chatMessage: "",
      chatAttachments: [],
      chatMessages: mainMessages,
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatQueueBySession: {},
      chatMessagesBySession: new Map(),
      chatRunId: null,
      sessionsShowArchived: false,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: null,
      settings,
      announceSessionSwitch: vi.fn(),
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      resetChatInputHistoryNavigation: vi.fn(),
    } as unknown as AppViewState);

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);

    switchChatSession(state, "agent:main:other");
    state.chatMessages = otherMessages;

    switchChatSession(state, "main");

    expect(state.chatMessages).toEqual(mainMessages);
    expect(state.chatMessagesBySession.get("agent:main:other")).toEqual(otherMessages);
  });

  it("restores configured main aliases without crossing agent scopes", () => {
    const opsMessages = [{ role: "assistant", content: [{ type: "text", text: "ops report" }] }];
    const mainMessages = [{ role: "assistant", content: [{ type: "text", text: "main report" }] }];
    const settings = createSettings();
    const state = withSessionCapability({
      sessionKey: "home",
      chatMessage: "",
      chatAttachments: [],
      chatMessages: opsMessages,
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatQueueBySession: {},
      chatMessagesBySession: new Map(),
      chatRunId: null,
      sessionsShowArchived: false,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: null,
      settings,
      announceSessionSwitch: vi.fn(),
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      resetChatInputHistoryNavigation: vi.fn(),
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "ops",
            mainKey: "home",
          },
        },
      },
    } as unknown as AppViewState);

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);

    switchChatSession(state, "agent:main:home");

    expect(state.chatMessages).toEqual([]);
    state.chatMessages = mainMessages;
    switchChatSession(state, "agent:ops:home");

    expect(state.chatMessages).toEqual(opsMessages);
    expect(state.chatMessagesBySession.get("agent:ops:main")).toEqual(opsMessages);
    expect(state.chatMessagesBySession.get("agent:main:main")).toEqual(mainMessages);
    expect(state.chatMessagesBySession.size).toBe(2);
  });

  it("restores visible messages across plain and canonical non-main keys", () => {
    const projectMessages = [
      { role: "assistant", content: [{ type: "text", text: "project report" }] },
    ];
    const mainMessages = [{ role: "assistant", content: [{ type: "text", text: "main reply" }] }];
    const settings = createSettings();
    const state = withSessionCapability({
      sessionKey: "project",
      chatMessage: "",
      chatAttachments: [],
      chatMessages: projectMessages,
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatQueueBySession: {},
      chatMessagesBySession: new Map(),
      chatRunId: null,
      sessionsShowArchived: false,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: null,
      settings,
      announceSessionSwitch: vi.fn(),
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      resetChatInputHistoryNavigation: vi.fn(),
    } as unknown as AppViewState);

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);

    switchChatSession(state, "main");
    state.chatMessages = mainMessages;

    switchChatSession(state, "agent:main:project");

    expect(state.chatMessages).toEqual(projectMessages);
    expect(state.chatMessagesBySession.get("agent:main:project")).toEqual(projectMessages);
    expect(state.chatMessagesBySession.size).toBe(2);
  });
});
