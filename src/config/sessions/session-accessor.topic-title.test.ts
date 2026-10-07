import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.read.js";
import {
  loadSessionEntry,
  recordInboundSessionMeta,
  replaceSessionEntry,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
});

it("publishes private Telegram topic renames when conversation label is the sender", async () => {
  const storePath = path.join(tempDirs.make("openclaw-topic-title-"), "sessions.json");
  const sessionKey = "agent:main:telegram:direct:42001:thread:77";
  const scope = { sessionKey, storePath };
  await replaceSessionEntry(scope, {
    sessionId: "private-topic-rename",
    updatedAt: 123,
    displayName: "New Chat",
  });
  const onLifecycle = vi.fn();
  const unsubscribe = onSessionLifecycleEvent(onLifecycle);
  onTestFinished(unsubscribe);
  const ctx = {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    From: "telegram:direct:42001",
    To: "telegram:42001",
    AccountId: "default",
    MessageThreadId: "77",
    ConversationLabel: "Synthetic Sender",
    SessionKey: sessionKey,
  };
  const rename = (title: string) =>
    recordInboundSessionMeta({ ...scope, ctx: { ...ctx, ThreadLabel: title } });
  const first = await rename("Test 4");
  expect(sessionDeliveryOrigin(first ?? undefined)?.label).toBe("Synthetic Sender");
  expect(first?.topicName).toBe("Test 4");
  expect(onLifecycle).toHaveBeenCalledWith(
    expect.objectContaining({ sessionKey, reason: "rename" }),
  );
  expect(onLifecycle).toHaveBeenCalledTimes(1);
  await rename("Test 4");
  expect(onLifecycle).toHaveBeenCalledTimes(1);
  await rename("Test 5");
  expect(onLifecycle).toHaveBeenCalledTimes(2);
  expect(loadSessionEntry(scope)).toMatchObject({
    sessionId: "private-topic-rename",
    displayName: "New Chat",
    topicName: "Test 5",
    updatedAt: 123,
  });
});
