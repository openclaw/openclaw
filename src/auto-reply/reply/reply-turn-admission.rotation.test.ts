import { afterEach, expect, it } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitTestReplyTurn, createSessionStoreFor } from "./reply-turn-admission.test-support.js";

const operations: ReplyOperation[] = [];

afterEach(() => {
  operations.forEach((operation) => operation.complete());
  operations.length = 0;
  testing.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
});

it("follows a completed predecessor's compaction into the next turn", async () => {
  const sessionKey = "agent:main:telegram:topic:compaction";
  const sessionId = "pre-compact-session";
  const nextSessionId = "post-compact-session";
  const storePath = createSessionStoreFor(sessionKey, sessionId);
  const initial = await admitTestReplyTurn({ sessionKey, sessionId, storePath });
  expect(initial.status).toBe("owned");
  if (initial.status !== "owned") {
    throw new Error("Expected the predecessor turn to be admitted");
  }
  operations.push(initial.operation);
  await replaceSessionEntry(
    { sessionKey, storePath },
    { sessionId: nextSessionId, label: "fresh compaction facts", updatedAt: Date.now() },
  );
  initial.operation.updateSessionId(nextSessionId);
  initial.operation.complete();

  const next = await admitTestReplyTurn({
    sessionKey,
    sessionId,
    storePath,
    expectedSessionId: sessionId,
    expectedActiveOperations: [initial.operation],
  });
  expect(next.status).toBe("owned");
  if (next.status === "owned") {
    operations.push(next.operation);
    expect(next.operation.sessionId).toBe(nextSessionId);
    expect(next.sessionEntry?.label).toBe("fresh compaction facts");
  }
});
