import { afterEach, describe, expect, it } from "vitest";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createReplyTurnRotationEvidence } from "./reply-turn-rotation.js";

afterEach(() => testing.resetSessionControllerForTest());

describe("physical reply rotation evidence", () => {
  it("observes only the selected physical controller for a duplicated logical key", () => {
    const sessionKey = "agent:main:duplicated";
    const first = createReplyOperation({
      sessionKey,
      sessionId: "copied-id",
      resetTriggered: false,
      target: captureSessionTarget({ storeScope: "/test/a.sqlite", sessionKey }),
    });
    const second = createReplyOperation({
      sessionKey,
      sessionId: "copied-id",
      resetTriggered: false,
      target: captureSessionTarget({ storeScope: "/test/b.sqlite", sessionKey }),
    });
    const evidence = createReplyTurnRotationEvidence({
      sessionKey,
      controller: getSessionControllerEntryForOperation(first),
      activeAtAdmission: first,
    });
    const observation = evidence.observeAdmission();
    const current = evidence.capturePreparation();
    second.updateSessionId("other-store-rotation");
    second.complete();
    expect(current()).toBe(true);
    expect(observation.changed()).toBe(false);
    first.updateSessionId("selected-store-rotation");
    first.complete();
    expect(current()).toBe(false);
    expect(observation.changed()).toBe(true);
    observation.recordCompletions();
    expect(evidence.takeStorelessRotation()?.sessionId).toBe("selected-store-rotation");
    observation.dispose();
  });
});
