import { beforeEach, describe, expect, it, vi } from "vitest";

/** Flush fire-and-forget microtask chains. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadSessionStore: vi.fn(() => ({})),
  updateSessionStore: vi.fn(
    async (_path: string, fn: (store: Record<string, unknown>) => unknown) => {
      return fn({});
    },
  ),
  snapshotSessionOrigin: vi.fn(),
  resolveMainSessionKey: vi.fn(() => "main"),
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/store",
    store: {},
    entry: { sessionId: "old-session-id", sessionFile: undefined as string | undefined },
    canonicalKey: "main",
    legacyKey: undefined as string | undefined,
  })),
  resolveGatewaySessionStoreTarget: vi.fn(() => ({
    storePath: "/tmp/store",
    canonicalKey: "main",
    storeKeys: ["main"],
    agentId: "main",
  })),
  triggerInternalHook: vi.fn(),
  createInternalHookEvent: vi.fn(() => ({ messages: [] })),
  getGlobalHookRunner: vi.fn(),
  abortEmbeddedPiRun: vi.fn(),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
  clearSessionQueues: vi.fn(),
  clearBootstrapSnapshot: vi.fn(),
  stopSubagentsForRequester: vi.fn(),
  unbindThreadBindingsBySessionKey: vi.fn(),
  archiveSessionTranscripts: vi.fn(() => []),
  getAcpSessionManager: vi.fn(() => ({
    cancelSession: vi.fn(),
    closeSession: vi.fn(),
  })),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  fsReadFile: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        readFile: mocks.fsReadFile,
      },
    },
  };
});

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  updateSessionStore: mocks.updateSessionStore,
  snapshotSessionOrigin: mocks.snapshotSessionOrigin,
  resolveMainSessionKey: mocks.resolveMainSessionKey,
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  triggerInternalHook: mocks.triggerInternalHook,
  createInternalHookEvent: mocks.createInternalHookEvent,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: mocks.abortEmbeddedPiRun,
  waitForEmbeddedPiRunEnd: mocks.waitForEmbeddedPiRunEnd,
}));

vi.mock("../../auto-reply/reply/queue.js", () => ({
  clearSessionQueues: mocks.clearSessionQueues,
}));

vi.mock("../../auto-reply/reply/abort.js", () => ({
  stopSubagentsForRequester: mocks.stopSubagentsForRequester,
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: mocks.clearBootstrapSnapshot,
}));

vi.mock("../../discord/monitor/thread-bindings.js", () => ({
  unbindThreadBindingsBySessionKey: mocks.unbindThreadBindingsBySessionKey,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
  resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
  archiveSessionTranscripts: mocks.archiveSessionTranscripts,
  listSessionsFromStore: vi.fn(),
  loadCombinedSessionStoreForGateway: vi.fn(),
  pruneLegacyStoreKeys: vi.fn(),
  readSessionPreviewItemsFromTranscript: vi.fn(),
  resolveSessionModelRef: vi.fn(),
  resolveSessionTranscriptCandidates: vi.fn(() => []),
}));

vi.mock("../sessions-patch.js", () => ({
  applySessionsPatchToStore: vi.fn(),
}));

vi.mock("../sessions-resolve.js", () => ({
  resolveSessionKeyFromResolveParams: vi.fn(),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: mocks.getAcpSessionManager,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../routing/session-key.js", () => ({
  isSubagentSessionKey: vi.fn(() => false),
  normalizeAgentId: vi.fn((id: string) => id),
  parseAgentSessionKey: vi.fn(() => ({ agentId: "main" })),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
}));

function makeHookRunner(opts: { hasBeforeReset: boolean }) {
  return {
    hasHooks: vi.fn((name: string) => {
      if (name === "before_reset") {
        return opts.hasBeforeReset;
      }
      if (name === "subagent_ended") {
        return false;
      }
      return false;
    }),
    runBeforeReset: vi.fn(),
    runSubagentEnded: vi.fn(),
  };
}

describe("sessions.reset before_reset plugin hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    // Session entry WITHOUT sessionFile — takes the "no session file" path
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/store",
      store: {},
      entry: { sessionId: "old-session-id", sessionFile: undefined },
      canonicalKey: "main",
      legacyKey: undefined,
    });
    mocks.resolveGatewaySessionStoreTarget.mockReturnValue({
      storePath: "/tmp/store",
      canonicalKey: "main",
      storeKeys: ["main"],
      agentId: "main",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, fn) => fn({}));
    mocks.waitForEmbeddedPiRunEnd.mockResolvedValue(true);
  });

  it("fires hookRunner.runBeforeReset when before_reset hooks are registered", async () => {
    const hookRunner = makeHookRunner({ hasBeforeReset: true });
    mocks.getGlobalHookRunner.mockReturnValue(hookRunner);

    const { sessionsHandlers } = await import("./sessions.js");

    const respond = vi.fn();
    await sessionsHandlers["sessions.reset"]({
      req: { type: "req" as const, id: "1", method: "sessions.reset" },
      params: { key: "main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    await flushPromises();

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(hookRunner.runBeforeReset).toHaveBeenCalledTimes(1);
    expect(hookRunner.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "reset" }),
      expect.objectContaining({
        agentId: "main",
        sessionKey: "main",
        sessionId: "old-session-id",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("does not fire hookRunner.runBeforeReset when no hooks are registered", async () => {
    const hookRunner = makeHookRunner({ hasBeforeReset: false });
    mocks.getGlobalHookRunner.mockReturnValue(hookRunner);

    const { sessionsHandlers } = await import("./sessions.js");

    const respond = vi.fn();
    await sessionsHandlers["sessions.reset"]({
      req: { type: "req" as const, id: "1", method: "sessions.reset" },
      params: { key: "main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    await flushPromises();

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(hookRunner.runBeforeReset).not.toHaveBeenCalled();
  });

  it("passes reason 'new' when p.reason is 'new'", async () => {
    const hookRunner = makeHookRunner({ hasBeforeReset: true });
    mocks.getGlobalHookRunner.mockReturnValue(hookRunner);

    const { sessionsHandlers } = await import("./sessions.js");

    const respond = vi.fn();
    await sessionsHandlers["sessions.reset"]({
      req: { type: "req" as const, id: "1", method: "sessions.reset" },
      params: { key: "main", reason: "new" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    await flushPromises();

    expect(hookRunner.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new" }),
      expect.any(Object),
    );
  });

  it("reads session transcript and passes messages when sessionFile is set", async () => {
    const hookRunner = makeHookRunner({ hasBeforeReset: true });
    mocks.getGlobalHookRunner.mockReturnValue(hookRunner);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/store",
      store: {},
      entry: { sessionId: "old-session-id", sessionFile: "/tmp/transcript.jsonl" },
      canonicalKey: "main",
      legacyKey: undefined,
    });
    mocks.fsReadFile.mockResolvedValue(
      '{"type":"message","message":{"role":"user","content":"hello"}}\n' +
        '{"type":"message","message":{"role":"assistant","content":"hi"}}\n',
    );

    const { sessionsHandlers } = await import("./sessions.js");

    const respond = vi.fn();
    await sessionsHandlers["sessions.reset"]({
      req: { type: "req" as const, id: "1", method: "sessions.reset" },
      params: { key: "main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });
    await flushPromises();

    expect(mocks.fsReadFile).toHaveBeenCalledWith("/tmp/transcript.jsonl", "utf-8");
    expect(hookRunner.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "/tmp/transcript.jsonl",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        reason: "reset",
      }),
      expect.any(Object),
    );
  });
});
