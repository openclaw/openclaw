import { expect, it } from "vitest";
import {
  ReplyRunAlreadyActiveError,
  resolveActiveSessionRunId,
  waitForReplyRunEndBySessionId,
  getSessionControllerOperation,
  waitForSessionRunIdle,
} from "../../sessions/session-controller.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";

export function registerReplyOperationRekeyCases() {
  it("moves a queued reservation to the target slot and frees the source", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:rekey-user";
    const targetSessionKey = "agent:main:telegram:group:rekey-target";
    const operation = createTestReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "rekey-session",
    });
    const sourceIdle = waitForSessionRunIdle(sourceSessionKey, 1_000);

    operation.updateSessionKey(targetSessionKey);

    expect(operation.key).toBe(targetSessionKey);
    expect(getSessionControllerOperation(sourceSessionKey)).toBeUndefined();
    expect(getSessionControllerOperation(targetSessionKey)).toBe(operation);
    expect(resolveActiveSessionRunId(targetSessionKey)).toBe("rekey-session");
    await expect(sourceIdle).resolves.toBe(true);

    const targetWait = waitForReplyRunEndBySessionId("rekey-session", 1_000);
    operation.complete();
    await expect(targetWait).resolves.toBe(true);
    expect(getSessionControllerOperation(targetSessionKey)).toBeUndefined();
  });

  it("refuses to rekey onto an owned target slot and keeps the source slot", () => {
    const targetSessionKey = "agent:main:telegram:group:rekey-owned";
    const sourceSessionKey = "agent:main:telegram:slash:rekey-blocked";
    const blocker = createTestReplyOperation({
      sessionKey: targetSessionKey,
      sessionId: "owned-session",
    });
    const operation = createTestReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "blocked-session",
    });

    expect(() => operation.updateSessionKey(targetSessionKey)).toThrow(ReplyRunAlreadyActiveError);
    expect(operation.key).toBe(sourceSessionKey);
    expect(getSessionControllerOperation(sourceSessionKey)).toBe(operation);
    expect(getSessionControllerOperation(targetSessionKey)).toBe(blocker);

    blocker.complete();
    operation.complete();
  });

  it("refuses to rekey after the run leaves the queued phase", () => {
    const operation = createTestReplyOperation({
      sessionKey: "agent:main:telegram:slash:rekey-late",
      sessionId: "late-session",
    });
    operation.setPhase("running");

    expect(() => operation.updateSessionKey("agent:main:telegram:group:rekey-late")).toThrow(
      /Cannot rekey reply operation/,
    );

    operation.complete();
  });
}
