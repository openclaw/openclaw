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
  emitSessionTranscriptUpdate: vi.fn(),
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
  emitSessionTranscriptUpdate: mocks.emitSessionTranscriptUpdate,
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
    (typeof sessionsMessagesHandlers)["sessions.messages.edit"]
  >[0]["context"];
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("sessions.messages.edit", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-edit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves messages appended after a stale activeLeafId", async () => {
    // Scenario:
    //   1. A branching op (e.g. previous edit) sets activeLeafId = X
    //   2. New messages are appended beyond X  (activeLeafId stays stale)
    //   3. User edits an early message
    //   → messages appended after the stale activeLeafId must be preserved

    const manager = SessionManager.create(tmpDir, tmpDir);
    const transcriptPath = manager.getSessionFile()!;

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

    // Simulate a branching op that set activeLeafId — branch from a1Id
    // and append a user+assistant pair
    manager.branch(a1Id);
    const u2Id = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second question" }],
      timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0]);

    const a2Id = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second answer" }],
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

    // ★ a2Id is the "stale activeLeafId" — the branching op stored it.
    // Now simulate further messages the user sent after the branching op
    // (these are children of a2Id, but activeLeafId was NOT updated).
    const _u3Id = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "third question" }],
      timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0]);

    const _a3Id = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "third answer" }],
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

    // Set up mocks with the STALE activeLeafId (a2Id, not a3Id)
    mocks.loadSessionEntryReturn = {
      cfg: {},
      storePath: "/fake/store.json",
      store: {},
      entry: {
        sessionId: "test-session",
        activeLeafId: a2Id, // stale! doesn't include u3 and a3
      },
      canonicalKey: "test-key",
    };
    mocks.resolveTranscriptFilePath.mockReturnValue(transcriptPath);

    const { fn: respond, calls } = makeRespond();

    // Edit the second user message (u2Id, not u1Id which is the root)
    await sessionsMessagesHandlers["sessions.messages.edit"]({
      req: {} as never,
      params: {
        key: "test-key",
        entryId: u2Id,
        content: "second question edited",
      },
      respond,
      context: makeContext(),
      client: {} as never,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);

    // Verify the new branch includes ALL messages after the edit,
    // including those appended beyond the stale activeLeafId.
    const payload = calls[0].payload as { ok: boolean; activeLeafId: string };
    const reopened = SessionManager.open(transcriptPath);
    const branch = reopened.getBranch(payload.activeLeafId);
    const messageEntries = branch.filter((e) => e.type === "message");
    const texts = messageEntries.map((e) => {
      const content = (e.message as unknown as Record<string, unknown>).content as Array<
        Record<string, unknown>
      >;
      return content[0].text;
    });

    // The edited message + all subsequent messages must be preserved
    expect(texts).toEqual([
      "hello", // u1 (untouched root)
      "hi there", // a1 (untouched)
      "second question edited", // u2 edited
      "second answer", // a2 (tail)
      "third question", // u3 (tail — would be lost with stale activeLeafId)
      "third answer", // a3 (tail — would be lost with stale activeLeafId)
    ]);
  });

  it("preserves all following messages when editing a message mid-branch", async () => {
    const manager = SessionManager.create(tmpDir, tmpDir);
    const transcriptPath = manager.getSessionFile()!;

    const _u1Id = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0]);

    const a1Id = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "reply one" }],
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

    const _u2Id = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0]);

    const _a2Id = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "reply two" }],
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

    // No activeLeafId set (simulates fresh session without prior branching)
    mocks.loadSessionEntryReturn = {
      cfg: {},
      storePath: "/fake/store.json",
      store: {},
      entry: {
        sessionId: "test-session",
        // no activeLeafId
      },
      canonicalKey: "test-key",
    };
    mocks.resolveTranscriptFilePath.mockReturnValue(transcriptPath);

    const { fn: respond, calls } = makeRespond();

    // Edit the first assistant message (a1Id — not the root u1Id)
    await sessionsMessagesHandlers["sessions.messages.edit"]({
      req: {} as never,
      params: {
        key: "test-key",
        entryId: a1Id,
        content: "reply one edited",
      },
      respond,
      context: makeContext(),
      client: {} as never,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);

    const payload = calls[0].payload as { ok: boolean; activeLeafId: string };
    const reopened = SessionManager.open(transcriptPath);
    const branch = reopened.getBranch(payload.activeLeafId);
    const messageEntries = branch.filter((e) => e.type === "message");
    const texts = messageEntries.map((e) => {
      const content = (e.message as unknown as Record<string, unknown>).content as Array<
        Record<string, unknown>
      >;
      return content[0].text;
    });

    expect(texts).toEqual(["first", "reply one edited", "second", "reply two"]);
  });

  it("edits a message on a non-active branch (fallback resolution)", async () => {
    const manager = SessionManager.create(tmpDir, tmpDir);
    const transcriptPath = manager.getSessionFile()!;

    const u1Id = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "original" }],
      timestamp: Date.now(),
    } as Parameters<SessionManager["appendMessage"]>[0]);

    const a1Id = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "reply A" }],
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

    // Branch from u1Id to create branchB
    manager.branch(u1Id);

    const a1bId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "reply B" }],
      provider: "test",
      model: "test-model",
      timestamp: Date.now(),
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

    // Natural leaf is now on branchB (a1bId).
    // Edit the assistant message on branchA (a1Id is a child of u1Id, on branchA).
    // Since the natural leaf is a1bId (branchB) and a1Id is on branchA (not on the
    // branchB path), the handler should fall back to walking a1Id's children.
    mocks.loadSessionEntryReturn = {
      cfg: {},
      storePath: "/fake/store.json",
      store: {},
      entry: {
        sessionId: "test-session",
        activeLeafId: a1bId,
      },
      canonicalKey: "test-key",
    };
    mocks.resolveTranscriptFilePath.mockReturnValue(transcriptPath);

    const { fn: respond, calls } = makeRespond();

    await sessionsMessagesHandlers["sessions.messages.edit"]({
      req: {} as never,
      params: {
        key: "test-key",
        entryId: a1Id,
        content: "reply A edited",
      },
      respond,
      context: makeContext(),
      client: {} as never,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);

    const payload = calls[0].payload as { ok: boolean; activeLeafId: string };
    const reopened = SessionManager.open(transcriptPath);
    const branch = reopened.getBranch(payload.activeLeafId);
    const messageEntries = branch.filter((e) => e.type === "message");
    const texts = messageEntries.map((e) => {
      const content = (e.message as unknown as Record<string, unknown>).content as Array<
        Record<string, unknown>
      >;
      return content[0].text;
    });

    // branchA was: u1→a1. a1 has no children on branchA, so tail is empty.
    expect(texts).toEqual(["original", "reply A edited"]);
  });
});
