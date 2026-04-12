import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {} as Record<string, unknown>,
  loadSessionEntryReturn: {} as Record<string, unknown>,
  resolveAgentIdFromSessionKey: vi.fn(() => null),
  resolveTranscriptFilePath: vi.fn(() => null as string | null),
  readSessionBranchMessages: vi.fn(() => []),
  clearBootstrapSnapshot: vi.fn(),
  updateSessionStore: vi.fn(async (_path: string, _fn: (s: Record<string, unknown>) => void) => {}),
  resolveGatewaySessionStoreTarget: vi.fn(() => ({ storePath: "/fake/store.json" })),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
}));

vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../../agents/bootstrap-cache.js", () => ({
  clearBootstrapSnapshot: mocks.clearBootstrapSnapshot,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: vi.fn((id: string) => id),
  parseAgentSessionKey: vi.fn(() => null),
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
}));

vi.mock("../session-branch-reader.js", () => ({
  resolveTranscriptFilePath: mocks.resolveTranscriptFilePath,
  findBranchTip: vi.fn(),
  getEntryVersions: vi.fn(() => []),
  readSessionBranchMessages: mocks.readSessionBranchMessages,
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: () => mocks.loadSessionEntryReturn,
  resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
}));

vi.mock("../sessions-patch.js", () => ({
  applySessionsPatchToStore: vi.fn(),
}));

vi.mock("../../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: vi.fn(),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {},
  pendingAssistantPrefill: new Map(),
}));

import { sessionsMessagesHandlers } from "./sessions-messages.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

let tmpDir: string;

function createBranchedSession(): {
  transcriptPath: string;
  /** Entry on branchA (the first/original branch) */
  branchAUserEntryId: string;
  branchAAssistantEntryId: string;
  /** Entry on branchB (the later branch, which is the file-level leaf) */
  branchBUserEntryId: string;
  branchBAssistantEntryId: string;
} {
  const manager = SessionManager.create(tmpDir, tmpDir);
  const transcriptPath = manager.getSessionFile()!;

  // -- Build a linear chain: user1 -> assistant1 -> user2 -> assistant2
  const _u1Id = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);

  const a1Id = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hi there" }],
    provider: "test",
    model: "test-model",
    timestamp: Date.now(),
    stopReason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

  // This is user2 + assistant2 on branchA (the original branch)
  const branchAUserEntryId = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "branch A message" }],
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);

  const branchAAssistantEntryId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "branch A reply" }],
    provider: "test",
    model: "test-model",
    timestamp: Date.now(),
    stopReason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

  // -- Now branch from assistant1 creating branchB
  manager.branch(a1Id);

  const branchBUserEntryId = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "branch B message" }],
    timestamp: Date.now(),
  } as Parameters<SessionManager["appendMessage"]>[0]);

  const branchBAssistantEntryId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "branch B reply" }],
    provider: "test",
    model: "test-model",
    timestamp: Date.now(),
    stopReason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

  // At this point the file-level leaf is branchBAssistantEntryId (last appended).
  // branchA entries are NOT on the branchB path.
  return {
    transcriptPath,
    branchAUserEntryId,
    branchAAssistantEntryId,
    branchBUserEntryId,
    branchBAssistantEntryId,
  };
}

function makeRespond() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const fn = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { fn, calls };
}

function makeContext() {
  return {
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: vi.fn(() => new Set<string>()),
  } as unknown as Parameters<
    (typeof sessionsMessagesHandlers)["sessions.messages.delete"]
  >[0]["context"];
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("sessions.messages.delete", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-delete-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes a message on the active branch", async () => {
    const session = createBranchedSession();

    // Point activeLeafId to branchB (the branch that matches the file-level leaf)
    mocks.loadSessionEntryReturn = {
      cfg: {},
      storePath: "/fake/store.json",
      store: {},
      entry: {
        sessionId: "test-session",
        activeLeafId: session.branchBAssistantEntryId,
      },
      canonicalKey: "test-key",
    };
    mocks.resolveTranscriptFilePath.mockReturnValue(session.transcriptPath);

    const { fn: respond, calls } = makeRespond();

    await sessionsMessagesHandlers["sessions.messages.delete"]({
      req: {} as never,
      params: {
        key: "test-key",
        entryId: session.branchBUserEntryId,
      },
      respond,
      context: makeContext(),
      client: {} as never,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({ ok: true });
  });

  it("deletes a message on a non-active branch (fallback resolution)", async () => {
    const session = createBranchedSession();

    // activeLeafId is NOT set – the handler falls back to manager.getLeafId()
    // which returns the file-level leaf (branchB tip), so branchA entries
    // are not on the active branch path.
    mocks.loadSessionEntryReturn = {
      cfg: {},
      storePath: "/fake/store.json",
      store: {},
      entry: {
        sessionId: "test-session",
        // no activeLeafId – triggers fallback to file-level leaf (branchB)
      },
      canonicalKey: "test-key",
    };
    mocks.resolveTranscriptFilePath.mockReturnValue(session.transcriptPath);

    const { fn: respond, calls } = makeRespond();

    // Delete a branchA message – this previously failed with
    // "entry not found in active branch"
    await sessionsMessagesHandlers["sessions.messages.delete"]({
      req: {} as never,
      params: {
        key: "test-key",
        entryId: session.branchAUserEntryId,
      },
      respond,
      context: makeContext(),
      client: {} as never,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({ ok: true });
  });

  it("deletes an assistant message on a non-active branch", async () => {
    const session = createBranchedSession();

    // activeLeafId points to branchB – target is branchA's assistant msg
    mocks.loadSessionEntryReturn = {
      cfg: {},
      storePath: "/fake/store.json",
      store: {},
      entry: {
        sessionId: "test-session",
        activeLeafId: session.branchBAssistantEntryId,
      },
      canonicalKey: "test-key",
    };
    mocks.resolveTranscriptFilePath.mockReturnValue(session.transcriptPath);

    const { fn: respond, calls } = makeRespond();

    await sessionsMessagesHandlers["sessions.messages.delete"]({
      req: {} as never,
      params: {
        key: "test-key",
        entryId: session.branchAAssistantEntryId,
      },
      respond,
      context: makeContext(),
      client: {} as never,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({ ok: true });
  });

  it("returns error for a truly nonexistent entry", async () => {
    const session = createBranchedSession();

    mocks.loadSessionEntryReturn = {
      cfg: {},
      storePath: "/fake/store.json",
      store: {},
      entry: {
        sessionId: "test-session",
        activeLeafId: session.branchBAssistantEntryId,
      },
      canonicalKey: "test-key",
    };
    mocks.resolveTranscriptFilePath.mockReturnValue(session.transcriptPath);

    const { fn: respond, calls } = makeRespond();

    await sessionsMessagesHandlers["sessions.messages.delete"]({
      req: {} as never,
      params: {
        key: "test-key",
        entryId: "nonexistent-id",
      },
      respond,
      context: makeContext(),
      client: {} as never,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(false);
    expect(calls[0].error).toMatchObject({ message: "entry not found" });
  });

  describe("multi-assistant turns", () => {
    function createMultiAssistantSession() {
      const manager = SessionManager.create(tmpDir, tmpDir);
      const transcriptPath = manager.getSessionFile()!;

      const userId = manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "tell me about X" }],
        timestamp: Date.now(),
      } as Parameters<SessionManager["appendMessage"]>[0]);

      const assistant1Id = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "X is interesting" }],
        provider: "test",
        model: "test-model",
        timestamp: Date.now(),
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

      const assistant2Id = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Also, Y relates to X" }],
        provider: "test",
        model: "test-model",
        timestamp: Date.now(),
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

      const assistant3Id = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Finally, Z" }],
        provider: "test",
        model: "test-model",
        timestamp: Date.now(),
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

      return { transcriptPath, userId, assistant1Id, assistant2Id, assistant3Id };
    }

    function setupMocks(session: { transcriptPath: string }, leafId: string) {
      mocks.loadSessionEntryReturn = {
        cfg: {},
        storePath: "/fake/store.json",
        store: {},
        entry: {
          sessionId: "test-session",
          activeLeafId: leafId,
        },
        canonicalKey: "test-key",
      };
      mocks.resolveTranscriptFilePath.mockReturnValue(session.transcriptPath);
    }

    it("deleting one assistant in a multi-assistant turn only removes that response", async () => {
      const session = createMultiAssistantSession();
      setupMocks(session, session.assistant3Id);

      const { fn: respond, calls } = makeRespond();

      await sessionsMessagesHandlers["sessions.messages.delete"]({
        req: {} as never,
        params: { key: "test-key", entryId: session.assistant2Id },
        respond,
        context: makeContext(),
        client: {} as never,
        isWebchatConnect: () => false,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].ok).toBe(true);

      // Verify the branch still contains the user message, assistant1, and assistant3
      const manager = SessionManager.open(session.transcriptPath);
      const newLeaf = manager.getLeafId()!;
      const branch = manager.getBranch(newLeaf);
      const messageEntries = branch.filter((e) => e.type === "message");
      const roles = messageEntries.map(
        (e) => (e.message as unknown as Record<string, unknown>).role,
      );
      // user + assistant1 + assistant3 remain; assistant2 was removed
      expect(roles).toEqual(["user", "assistant", "assistant"]);
      const texts = messageEntries.map((e) => {
        const content = (e.message as unknown as Record<string, unknown>).content as Array<
          Record<string, unknown>
        >;
        return content[0].text;
      });
      expect(texts).toEqual(["tell me about X", "X is interesting", "Finally, Z"]);
    });

    it("deleting the only assistant in a single-assistant turn removes the whole turn", async () => {
      const manager = SessionManager.create(tmpDir, tmpDir);
      const transcriptPath = manager.getSessionFile()!;

      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      } as Parameters<SessionManager["appendMessage"]>[0]);

      const assistantId = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        provider: "test",
        model: "test-model",
        timestamp: Date.now(),
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

      setupMocks({ transcriptPath }, assistantId);

      const { fn: respond, calls } = makeRespond();

      await sessionsMessagesHandlers["sessions.messages.delete"]({
        req: {} as never,
        params: { key: "test-key", entryId: assistantId },
        respond,
        context: makeContext(),
        client: {} as never,
        isWebchatConnect: () => false,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].ok).toBe(true);

      // Whole turn deleted – branch should be empty
      const mgr = SessionManager.open(transcriptPath);
      const leaf = mgr.getLeafId();
      const branch = leaf ? mgr.getBranch(leaf) : [];
      const messageEntries = branch.filter((e) => e.type === "message");
      expect(messageEntries).toHaveLength(0);
    });

    it("deleting user message in a multi-assistant turn removes the whole turn", async () => {
      const session = createMultiAssistantSession();
      setupMocks(session, session.assistant3Id);

      const { fn: respond, calls } = makeRespond();

      await sessionsMessagesHandlers["sessions.messages.delete"]({
        req: {} as never,
        params: { key: "test-key", entryId: session.userId },
        respond,
        context: makeContext(),
        client: {} as never,
        isWebchatConnect: () => false,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].ok).toBe(true);

      // Whole turn deleted – branch should be empty
      const mgr = SessionManager.open(session.transcriptPath);
      const leaf = mgr.getLeafId();
      const branch = leaf ? mgr.getBranch(leaf) : [];
      const messageEntries = branch.filter((e) => e.type === "message");
      expect(messageEntries).toHaveLength(0);
    });
  });
});
