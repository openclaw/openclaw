import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { listConversations, resolveConversation } from "./conversation-registry.js";
import { upsertSessionEntry } from "./session-accessor.js";

describe("conversation registry", () => {
  let tempDir: string;
  let storePath: string;

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-conversations-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("links multiple direct peers to a shared main context without conflating addresses", async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    await upsertSessionEntry(scope, {
      sessionId: "shared-main-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-a" },
    });
    await upsertSessionEntry(scope, {
      sessionId: "shared-main-session",
      updatedAt: 200,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-b" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-b" },
    });

    const conversations = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(conversations).toHaveLength(2);
    expect(conversations.map((entry) => entry.target).toSorted()).toEqual([
      "reef:peer-a",
      "reef:peer-b",
    ]);
    expect(conversations.every((entry) => entry.role === "participant")).toBe(true);
    expect(conversations.every((entry) => entry.sessionKey === scope.sessionKey)).toBe(true);

    const peerA = conversations.find((entry) => entry.target === "reef:peer-a");
    expect(peerA).toBeDefined();
    expect(resolveConversation({ agentId: "main", storePath }, peerA!.conversationRef)).toEqual(
      peerA,
    );
  });

  it("resolves historical addresses through the current session binding after reset", async () => {
    const sessionKey = "agent:main:reef:direct:peer-a";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntry(scope, {
      sessionId: "old-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-a" },
    });
    const [historical] = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(historical?.sessionId).toBe("old-session");

    await upsertSessionEntry(scope, {
      sessionId: "current-session",
      updatedAt: 200,
      chatType: "direct",
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, historical?.conversationRef ?? "missing"),
    ).toMatchObject({
      conversationRef: historical?.conversationRef,
      sessionId: "current-session",
      sessionKey,
      target: "reef:peer-a",
    });
  });
});
