import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildChannelSourceTurnId } from "../../auto-reply/reply/source-turn-id.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
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
const probeConversation = { provider: "telegram", accountId: "acct-1", conversationId: "chat-1" };

describe("inactive transcript identity probes", () => {
  const tempDirs = createTempDirTracker();

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  async function createSession() {
    const stateDir = tempDirs.make("openclaw-inactive-identities-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveDefaultSessionStorePath(agentId);
    const scope = { agentId, env, sessionId: "inactive-source", sessionKey, storePath };
    const probe = { agentId, sessionKey, storePath };
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
    ) =>
      appendTranscriptMessage(scope, {
        eventId,
        message: message as never,
        now: Date.parse(timestamp),
        parentId,
      });
    const sourceTurnId = (messageId: string, conversationId = probeConversation.conversationId) =>
      buildChannelSourceTurnId({ ...probeConversation, conversationId, messageId });
    await appendTurn(
      "user-1",
      null,
      {
        role: "user",
        content: "retained question",
        idempotencyKey: sourceTurnId("101"),
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
        idempotencyKey: sourceTurnId("102"),
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
    return { env, probe, scope, stateDir, appendTurn, sourceTurnId };
  }

  it("reports recorded turns active until a branch is cut", async () => {
    const { probe } = await createSession();

    expect(await isInactiveTranscriptEntry(probe, "user-2")).toBe(false);
    expect(
      await isInactiveTransportMessage(probe, { ...probeConversation, messageId: "102" }),
    ).toBe(false);
  });

  it("marks exactly the turns a rewind cut, on both identity probes", async () => {
    const { env, probe } = await createSession();
    const result = await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });
    expect(result.status).toBe("created");

    expect(await isInactiveTranscriptEntry(probe, "user-2")).toBe(true);
    expect(await isInactiveTranscriptEntry(probe, "assistant-2")).toBe(true);
    expect(await isInactiveTranscriptEntry(probe, "user-1")).toBe(false);
    expect(await isInactiveTranscriptEntry(probe, "assistant-1")).toBe(false);
    expect(
      await isInactiveTransportMessage(probe, { ...probeConversation, messageId: "102" }),
    ).toBe(true);
    expect(
      await isInactiveTransportMessage(probe, { ...probeConversation, messageId: "101" }),
    ).toBe(false);
  });

  it("does not treat another conversation's same transport id as cut", async () => {
    const { env, probe } = await createSession();
    await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });

    expect(
      await isInactiveTransportMessage(probe, {
        ...probeConversation,
        conversationId: "someone-else",
        messageId: "102",
      }),
    ).toBe(false);
    expect(await isInactiveTransportMessage(probe, { messageId: "102" })).toBe(false);
  });

  it("keeps a cut turn whose transport origin was never recorded", async () => {
    const { env, probe, appendTurn, stateDir } = await createSession();
    await appendTurn(
      "user-legacy",
      "assistant-2",
      { role: "user", content: "discarded question without a conversation" },
      "2026-07-18T00:00:05.000Z",
    );
    await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
    await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });

    expect(await isInactiveTranscriptEntry(probe, "user-legacy")).toBe(true);
    expect(
      await isInactiveTransportMessage(probe, { ...probeConversation, messageId: "109" }),
    ).toBe(false);
  });

  it("treats a rewind before the first message as an empty active branch", async () => {
    const { env, probe } = await createSession();
    const result = await rewindSessionToMessage({ agentId, env, entryId: "user-1", sessionKey });
    expect(result.status).toBe("created");

    expect(await isInactiveTranscriptEntry(probe, "user-1")).toBe(true);
    expect(await isInactiveTranscriptEntry(probe, "assistant-2")).toBe(true);
    expect(
      await isInactiveTransportMessage(probe, { ...probeConversation, messageId: "101" }),
    ).toBe(true);
  });

  it("abstains when the entry was never recorded", async () => {
    const { probe } = await createSession();

    expect(await isInactiveTranscriptEntry(probe, "no-such-entry")).toBe(false);
  });
});
