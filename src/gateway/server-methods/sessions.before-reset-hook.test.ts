import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

// ── Shared mock state ──────────────────────────────────────────────────────
const mocks = {
  triggerInternalHook: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace/main"),
  loadConfig: vi.fn(() => ({})),
  resolveGatewaySessionStoreTarget: vi.fn(() => ({
    agentId: "main",
    storePath: "/tmp/store.json",
    canonicalKey: "agent:main:test-key",
    storeKeys: ["agent:main:test-key"],
  })),
  loadSessionEntry: vi.fn(() => ({
    entry: undefined,
    legacyKey: undefined,
    canonicalKey: undefined,
  })),
  updateSessionStore: vi.fn(
    async (_path: string, fn: (store: Record<string, SessionEntry>) => SessionEntry) => {
      const store: Record<string, SessionEntry> = {};
      return fn(store);
    },
  ),
  ensureSessionRuntimeCleanup: vi.fn(async () => null),
  closeAcpRuntimeForSession: vi.fn(async () => null),
  getAcpSessionManager: vi.fn(() => null),
  emitSessionUnboundLifecycleEvent: vi.fn(),
  archiveSessionTranscriptsForSession: vi.fn(),
};

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(() => ({ messages: [] })),
  triggerInternalHook: mocks.triggerInternalHook,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  snapshotSessionOrigin: vi.fn(),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock(import("../../routing/session-key.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isSubagentSessionKey: vi.fn(() => false),
    normalizeAgentId: vi.fn((id: string) => id),
    parseAgentSessionKey: vi.fn(() => ({ agentId: "main" })),
  };
});

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../discord/monitor/thread-bindings.js", () => ({
  unbindThreadBindingsBySessionKey: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
}));

vi.mock("../../auto-reply/reply/abort.js", () => ({
  stopSubagentsForRequester: vi.fn(),
}));

vi.mock("../../auto-reply/reply/queue.js", () => ({
  clearSessionQueues: vi.fn(),
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: vi.fn(),
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: mocks.getAcpSessionManager,
}));

// Mock the session-utils barrel used by sessions.ts
vi.mock("../session-utils.js", () => ({
  archiveFileOnDisk: vi.fn(),
  archiveSessionTranscripts: vi.fn(),
  listSessionsFromStore: vi.fn(() => []),
  loadCombinedSessionStoreForGateway: vi.fn(() => ({})),
  loadSessionEntry: mocks.loadSessionEntry,
  pruneLegacyStoreKeys: vi.fn(),
  readSessionPreviewItemsFromTranscript: vi.fn(() => []),
  resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
  resolveSessionModelRef: vi.fn(() => ({ model: "test", provider: "test" })),
  resolveSessionTranscriptCandidates: vi.fn(() => []),
  migrateAndPruneSessionStoreKey: vi.fn(({ key }: { key: string }) => ({ primaryKey: key })),
  archiveSessionTranscriptsForSession: mocks.archiveSessionTranscriptsForSession,
  emitSessionUnboundLifecycleEvent: mocks.emitSessionUnboundLifecycleEvent,
  ensureSessionRuntimeCleanup: mocks.ensureSessionRuntimeCleanup,
  closeAcpRuntimeForSession: mocks.closeAcpRuntimeForSession,
}));

vi.mock("../protocol/index.js", () => ({
  ErrorCodes: { INVALID_REQUEST: "INVALID_REQUEST" },
  errorShape: vi.fn((_code: string, msg: string) => ({ error: msg })),
  validateSessionsCompactParams: vi.fn(() => true),
  validateSessionsDeleteParams: vi.fn(() => true),
  validateSessionsListParams: vi.fn(() => true),
  validateSessionsPatchParams: vi.fn(() => true),
  validateSessionsPreviewParams: vi.fn(() => true),
  validateSessionsResetParams: vi.fn(() => true),
  validateSessionsResolveParams: vi.fn(() => true),
}));

// ── Helpers ────────────────────────────────────────────────────────────────
function makeHookRunner(opts: { hasBeforeReset: boolean }) {
  return {
    hasHooks: vi.fn((name: string) => name === "before_reset" && opts.hasBeforeReset),
    runBeforeReset: vi.fn(async () => {}),
    runSubagentEnded: vi.fn(),
  };
}

type RespondFn = (success: boolean, data: unknown, error: unknown) => void;

async function callSessionsReset(params: {
  key: string;
  reason?: string;
  entry?: SessionEntry;
  sessionFile?: string;
}) {
  // Dynamic import so mocks are applied
  const mod = await import("./sessions.js");
  const handlers = mod.sessionsHandlers;
  const handler = handlers["sessions.reset"];
  const respond = vi.fn() as unknown as RespondFn;

  if (params.entry) {
    mocks.loadSessionEntry.mockReturnValue({
      entry: { ...params.entry, sessionFile: params.sessionFile },
      legacyKey: undefined,
      canonicalKey: "agent:main:test-key",
    });
  }

  await handler({
    params: { key: params.key, reason: params.reason ?? "reset" },
    respond,
    client: null,
    isWebchatConnect: () => false,
  });

  // Flush fire-and-forget microtasks
  await new Promise((r) => setTimeout(r, 50));
  return { respond };
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("sessions.reset before_reset plugin hook (#25074)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires hookRunner.runBeforeReset when before_reset hooks are registered", async () => {
    const runner = makeHookRunner({ hasBeforeReset: true });
    mocks.getGlobalHookRunner.mockReturnValue(runner);

    await callSessionsReset({ key: "agent:main:test-key" });

    expect(runner.hasHooks).toHaveBeenCalledWith("before_reset");
    expect(runner.runBeforeReset).toHaveBeenCalledOnce();
    expect(runner.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "reset", messages: [] }),
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:test-key",
        workspaceDir: "/workspace/main",
      }),
    );
  });

  it("does NOT fire when no before_reset hooks are registered", async () => {
    const runner = makeHookRunner({ hasBeforeReset: false });
    mocks.getGlobalHookRunner.mockReturnValue(runner);

    await callSessionsReset({ key: "agent:main:test-key" });

    expect(runner.hasHooks).toHaveBeenCalledWith("before_reset");
    expect(runner.runBeforeReset).not.toHaveBeenCalled();
  });

  it('passes reason "new" when p.reason is "new"', async () => {
    const runner = makeHookRunner({ hasBeforeReset: true });
    mocks.getGlobalHookRunner.mockReturnValue(runner);

    await callSessionsReset({ key: "agent:main:test-key", reason: "new" });

    expect(runner.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new" }),
      expect.anything(),
    );
  });

  it("reads session transcript and passes parsed messages", async () => {
    const runner = makeHookRunner({ hasBeforeReset: true });
    mocks.getGlobalHookRunner.mockReturnValue(runner);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-test-"));
    const transcriptPath = path.join(tmpDir, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
      JSON.stringify({ type: "other", data: "ignored" }),
      "",
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"));

    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      sessionFile: transcriptPath,
    };

    await callSessionsReset({ key: "agent:main:test-key", entry, sessionFile: transcriptPath });

    expect(runner.runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: transcriptPath,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
      expect.anything(),
    );

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("does NOT fire hook when session runtime cleanup fails", async () => {
    const runner = makeHookRunner({ hasBeforeReset: true });
    mocks.getGlobalHookRunner.mockReturnValue(runner);

    // Provide a sessionId so ensureSessionRuntimeCleanup calls waitForEmbeddedPiRunEnd
    const entry: SessionEntry = { sessionId: "active-session", updatedAt: Date.now() };
    mocks.loadSessionEntry.mockReturnValue({
      entry,
      legacyKey: undefined,
      canonicalKey: "agent:main:test-key",
    });

    // Simulate active run that won't end (waitForEmbeddedPiRunEnd returns false → error)
    const { waitForEmbeddedPiRunEnd } = await import("../../agents/pi-embedded.js");
    vi.mocked(waitForEmbeddedPiRunEnd).mockResolvedValue(false);

    const { respond } = await callSessionsReset({ key: "agent:main:test-key" });

    expect(runner.hasHooks).toHaveBeenCalledWith("before_reset");
    expect(runner.runBeforeReset).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
