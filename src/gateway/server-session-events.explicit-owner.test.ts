import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  broadcastToConnIds,
  legacyDefaultAgentIdMock,
  loadGatewaySessionRowMock,
  resolveVisibleActiveSessionRunStateMock,
} = vi.hoisted(() => ({
  broadcastToConnIds: vi.fn(),
  legacyDefaultAgentIdMock: vi.fn(() => undefined as string | undefined),
  loadGatewaySessionRowMock: vi.fn(),
  resolveVisibleActiveSessionRunStateMock: vi.fn((): { active: boolean; runIds: string[] } => ({
    active: false,
    runIds: [],
  })),
}));

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveDefaultAgentId: vi.fn(() => "main"),
    tryResolveDefaultAgentId: vi.fn(() => undefined),
  };
});

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
  })),
}));

vi.mock("../config/legacy.default-agent-owner.js", () => ({
  resolveSessionStoreCompatibilityAgentId: () => legacyDefaultAgentIdMock() ?? "main",
  tryGetLegacyDefaultAgentId: legacyDefaultAgentIdMock,
  tryResolveLegacyCompatibilityAgentId: legacyDefaultAgentIdMock,
}));

vi.mock("../plugins/gateway-events.js", () => ({
  hasPluginSessionsChangedSubscribers: vi.fn(() => false),
}));

vi.mock("./server-methods/session-active-runs.js", () => ({
  resolveVisibleActiveSessionRunState: resolveVisibleActiveSessionRunStateMock,
}));

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return { ...actual, loadGatewaySessionRow: loadGatewaySessionRowMock };
});

import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import {
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";

const globalRow = {
  key: "global",
  kind: "global",
  sessionId: "session-global",
  updatedAt: 1,
} as const;

describe("server session events without a compatibility owner", () => {
  beforeEach(() => {
    broadcastToConnIds.mockReset();
    legacyDefaultAgentIdMock.mockReset().mockReturnValue(undefined);
    loadGatewaySessionRowMock.mockReset().mockReturnValue(globalRow);
    resolveVisibleActiveSessionRunStateMock
      .mockReset()
      .mockReturnValue({ active: false, runIds: [] });
  });

  it("keeps ownerless lifecycle snapshots ownerless", () => {
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    handler({ sessionKey: "global", reason: "updated" } as never);

    expect(resolveVisibleActiveSessionRunStateMock).not.toHaveBeenCalled();
    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toEqual(
      expect.objectContaining({ hasActiveRun: true }),
    );
  });

  it("projects a bare lifecycle event through its explicit owner", () => {
    loadGatewaySessionRowMock.mockReturnValue({
      ...globalRow,
      key: "incident-42",
      kind: "other",
    });
    resolveVisibleActiveSessionRunStateMock.mockReturnValue({
      active: true,
      runIds: ["run-work-incident"],
    });
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    handler({ sessionKey: "incident-42", agentId: "work", reason: "updated" });

    expect(loadGatewaySessionRowMock).toHaveBeenCalledWith("incident-42", {
      agentId: "work",
    });
    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work", canonicalKey: "incident-42" }),
    );
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        agentId: "work",
        hasActiveRun: true,
        activeRunIds: ["run-work-incident"],
      }),
    );
  });

  it("keeps a selected global owner separate from the retained compatibility owner", () => {
    legacyDefaultAgentIdMock.mockReturnValue("main");
    emitSessionsChanged(
      {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        }),
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      } as never,
      { sessionKey: "global", agentId: "work", reason: "updated" },
    );

    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work", defaultAgentId: "main" }),
    );
  });

  it("uses the retained owner for an unselected migrated global event", () => {
    legacyDefaultAgentIdMock.mockReturnValue("main");
    emitSessionsChanged(
      {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        }),
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      } as never,
      { sessionKey: "global", reason: "updated" },
    );

    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: undefined, defaultAgentId: "main" }),
    );
  });

  it("projects a selected global run without a compatibility owner", () => {
    resolveVisibleActiveSessionRunStateMock.mockReturnValue({
      active: true,
      runIds: ["run-work"],
    });
    emitSessionsChanged(
      {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        }),
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      } as never,
      { sessionKey: "global", agentId: "work", reason: "updated" },
    );

    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work", defaultAgentId: undefined }),
    );
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ hasActiveRun: true, activeRunIds: ["run-work"] }),
    );
  });

  it("projects an explicitly owned non-global run without a compatibility owner", () => {
    loadGatewaySessionRowMock.mockReturnValue({
      ...globalRow,
      key: "agent:work:incident",
      kind: "other",
    });
    resolveVisibleActiveSessionRunStateMock.mockReturnValue({
      active: true,
      runIds: ["run-incident"],
    });
    emitSessionsChanged(
      {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        }),
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      } as never,
      { sessionKey: "agent:work:incident", reason: "updated" },
    );

    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalled();
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ hasActiveRun: true, activeRunIds: ["run-incident"] }),
    );
  });

  it("uses the selected owner to resolve a bare non-global session", () => {
    loadGatewaySessionRowMock.mockReturnValue({
      ...globalRow,
      key: "incident-42",
      kind: "other",
    });
    emitSessionsChanged(
      {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        }),
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      } as never,
      { sessionKey: "incident-42", agentId: "work", reason: "updated" },
    );

    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultAgentId: "work" }),
    );
  });

  it("does not project an ownerless unselected global run", () => {
    resolveVisibleActiveSessionRunStateMock.mockReturnValue({
      active: true,
      runIds: ["run-ownerless"],
    });
    emitSessionsChanged(
      {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
        }),
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      } as never,
      { sessionKey: "global", reason: "updated" },
    );

    expect(resolveVisibleActiveSessionRunStateMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toEqual(
      expect.objectContaining({ hasActiveRun: true }),
    );
  });

  it("keeps ownerless transcript snapshots ownerless", async () => {
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      sessionMessageSubscribers: { get: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    handler({
      sessionFile: "/tmp/session-global.jsonl",
      sessionKey: "global",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      messageSeq: 1,
    } as never);

    await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalled());
    expect(resolveVisibleActiveSessionRunStateMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toEqual(
      expect.objectContaining({ hasActiveRun: true }),
    );
  });

  it("keeps the compatibility owner separate from an explicit transcript owner", async () => {
    legacyDefaultAgentIdMock.mockReturnValue("main");
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      sessionMessageSubscribers: { get: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    handler({
      sessionFile: "/tmp/session-work-global.jsonl",
      target: {
        agentId: "work",
        sessionId: "session-global",
        sessionKey: "global",
        storePath: "/tmp/work-sessions.json",
      },
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      messageSeq: 1,
    } as never);

    await vi.waitFor(() => expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalled());
    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work", defaultAgentId: "main" }),
    );
  });

  it("projects a bare transcript session through its selected owner", async () => {
    loadGatewaySessionRowMock.mockReturnValue({
      ...globalRow,
      key: "incident-42",
      kind: "other",
    });
    resolveVisibleActiveSessionRunStateMock.mockReturnValue({
      active: true,
      runIds: ["run-work-incident"],
    });
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      sessionMessageSubscribers: { get: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    handler({
      sessionFile: "/tmp/session-work-incident.jsonl",
      target: {
        agentId: "work",
        sessionId: "session-global",
        sessionKey: "incident-42",
        storePath: "/tmp/work-sessions.json",
      },
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      messageSeq: 1,
    } as never);

    await vi.waitFor(() => expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalled());
    expect(resolveVisibleActiveSessionRunStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedKey: "incident-42",
        canonicalKey: "incident-42",
        agentId: "work",
      }),
    );
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ hasActiveRun: true, activeRunIds: ["run-work-incident"] }),
    );
  });
});
