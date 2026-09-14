import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  rewindSessionToMessage,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";
import { readInactiveSessionContextIdentities } from "./transcript-inactive-identities.js";

const agentId = "main";
const sessionKey = "agent:main:telegram:dm:chat-1";

describe("readInactiveSessionContextIdentities", () => {
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
        __openclaw: { transport: { channel: "telegram", messageId: "101" } },
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
        __openclaw: { transport: { channel: "telegram", messageId: "102" } },
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
    return { env, scope, appendTurn };
  }

  it("returns empty identities while no branch was ever cut", async () => {
    await createSession();

    const identities = await readInactiveSessionContextIdentities({ agentId, sessionKey });

    expect(identities.transcriptEntryIds.size).toBe(0);
    expect(identities.channelMessageIds.size).toBe(0);
  });

  it("collects entry and channel identities cut by a rewind", async () => {
    const { env } = await createSession();
    const result = await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });
    expect(result.status).toBe("created");

    const identities = await readInactiveSessionContextIdentities({ agentId, sessionKey });

    expect([...identities.transcriptEntryIds].sort()).toEqual(["assistant-2", "user-2"]);
    expect(identities.channelMessageIds.get("telegram")).toEqual(new Set(["102"]));
  });

  it("keeps collecting identities across repeated rewinds", async () => {
    const { env, scope, appendTurn } = await createSession();
    await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });
    const rotated = loadSessionEntry(scope);
    const branchScope = { ...scope, sessionId: rotated?.sessionId ?? scope.sessionId };
    await appendTurn(
      "user-3",
      "assistant-1",
      {
        role: "user",
        content: "second discarded question",
        __openclaw: { transport: { channel: "telegram", messageId: "103" } },
      },
      "2026-07-18T00:00:05.000Z",
      branchScope,
    );
    await appendTurn(
      "assistant-3",
      "user-3",
      { role: "assistant", content: "second discarded answer" },
      "2026-07-18T00:00:06.000Z",
      branchScope,
    );
    const second = await rewindSessionToMessage({ agentId, env, entryId: "user-3", sessionKey });
    expect(second.status).toBe("created");

    const identities = await readInactiveSessionContextIdentities({ agentId, sessionKey });

    expect([...identities.transcriptEntryIds].sort()).toEqual([
      "assistant-2",
      "assistant-3",
      "user-2",
      "user-3",
    ]);
    expect(identities.channelMessageIds.get("telegram")).toEqual(new Set(["102", "103"]));
  });
});
