import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  rewindSessionToMessage,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";
import {
  isInactiveTranscriptEntry,
  isInactiveTransportMessage,
} from "./transcript-inactive-identities.js";

const agentId = "main";
const sessionKey = "agent:main:telegram:dm:chat-1";
const conversationRef = "telegram:acct-1:dm:chat-1";

describe("inactive-branch probes", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  async function createSession() {
    const stateDir = tempDirs.make("openclaw-inactive-identities-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const scope = { agentId, env, sessionId: "inactive-source", sessionKey };
    await upsertSessionEntryCore(scope, { sessionId: "inactive-source", updatedAt: 1_000 });
    await appendTranscriptEvent(scope, {
      type: "session",
      id: "inactive-source",
      version: 3,
      timestamp: "2026-07-18T00:00:00.000Z",
    });
    const appendTurn = (
      eventId: string,
      parentId: string | null,
      message: Record<string, unknown>,
      timestamp: string,
      targetScope = scope,
    ) =>
      appendTranscriptMessage(targetScope, {
        eventId,
        message: message as never,
        now: Date.parse(timestamp),
        parentId,
      });
    await appendTurn(
      "user-1",
      null,
      {
        role: "user",
        content: "retained question",
        idempotencyKey: `conversation-inbound:${conversationRef}:101`,
        __openclaw: { transport: { channel: "telegram", conversationRef, messageId: "101" } },
      },
      "2026-07-18T00:00:01.000Z",
    );
    await appendTurn(
      "assistant-1",
      "user-1",
      { role: "assistant", content: "retained answer" },
      "2026-07-18T00:00:02.000Z",
    );
    await appendTurn(
      "user-2",
      "assistant-1",
      {
        role: "user",
        content: "discarded question",
        idempotencyKey: `conversation-inbound:${conversationRef}:102`,
        __openclaw: { transport: { channel: "telegram", conversationRef, messageId: "102" } },
      },
      "2026-07-18T00:00:03.000Z",
    );
    await appendTurn(
      "assistant-2",
      "user-2",
      { role: "assistant", content: "discarded answer" },
      "2026-07-18T00:00:04.000Z",
    );
    await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
    return { env, scope, stateDir, appendTurn };
  }

  it("reports everything active while no branch was ever cut", async () => {
    await createSession();

    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "user-2")).toBe(false);
    expect(
      await isInactiveTransportMessage({ agentId, sessionKey }, { conversationRef, messageId: "102" }),
    ).toBe(false);
  });

  it("marks exactly the turns cut by a rewind, on both probes", async () => {
    const { env } = await createSession();
    const result = await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });
    expect(result.status).toBe("created");

    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "user-2")).toBe(true);
    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "assistant-2")).toBe(true);
    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "user-1")).toBe(false);
    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "assistant-1")).toBe(false);
    expect(
      await isInactiveTransportMessage({ agentId, sessionKey }, { conversationRef, messageId: "102" }),
    ).toBe(true);
    expect(
      await isInactiveTransportMessage({ agentId, sessionKey }, { conversationRef, messageId: "101" }),
    ).toBe(false);
  });

  it("scopes the transport probe to the exact conversation", async () => {
    const { env } = await createSession();
    await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });

    expect(
      await isInactiveTransportMessage(
        { agentId, sessionKey },
        { conversationRef: "telegram:acct-1:dm:someone-else", messageId: "102" },
      ),
    ).toBe(false);
    expect(await isInactiveTransportMessage({ agentId, sessionKey }, { messageId: "102" })).toBe(
      false,
    );
  });

  it("retains a cut turn whose transport origin was never recorded", async () => {
    const { env, appendTurn } = await createSession();
    await appendTurn(
      "user-legacy",
      "assistant-2",
      {
        role: "user",
        content: "discarded question without a recorded conversation",
        __openclaw: { transport: { channel: "telegram", messageId: "109" } },
      },
      "2026-07-18T00:00:05.000Z",
    );
    await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });

    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "user-legacy")).toBe(true);
    expect(
      await isInactiveTransportMessage({ agentId, sessionKey }, { conversationRef, messageId: "109" }),
    ).toBe(false);
  });

  it("treats a rewind before the first message as a valid empty branch", async () => {
    const { scope, stateDir } = await createSession();
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf-ctl-empty-root",
      parentId: "assistant-2",
      targetId: null,
      appendParentId: null,
      timestamp: "2026-07-18T00:00:05.000Z",
    });
    await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);

    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "user-1")).toBe(true);
    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "assistant-2")).toBe(true);
    expect(
      await isInactiveTransportMessage({ agentId, sessionKey }, { conversationRef, messageId: "101" }),
    ).toBe(true);
  });

  it("abstains on an entry that was never recorded", async () => {
    await createSession();

    expect(await isInactiveTranscriptEntry({ agentId, sessionKey }, "no-such-entry")).toBe(false);
  });
});
