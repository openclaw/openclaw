import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { stopSession } from "../../sessions/session-controller.stop.js";
import { resetSessionControllerStateForTest } from "../../sessions/session-lifecycle-admission.test-support.js";
import { captureChannelSessionStop } from "./abort-operation.js";

afterEach(() => resetSessionControllerStateForTest());

it("keeps a global session's agent owner through an agentless lifecycle mutation", async () => {
  const storePath = "/synthetic/shared-global/sessions.sqlite";
  const globalKey = "global";
  const active = createReplyOperation({
    sessionKey: globalKey,
    sessionId: "global-main",
    agentId: "main",
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey: globalKey,
      incarnation: "global-main",
      agentId: "main",
    }),
  });
  const entered = createDeferred();
  const release = createDeferred();
  const mutation = runSessionMutation({
    scope: storePath,
    identities: [globalKey, "global-main"],
    policy: "wait",
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  let other: ReturnType<typeof reserveSessionControllerSource> | undefined;
  try {
    await entered.promise;
    other = reserveSessionControllerSource(globalKey, {
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey: globalKey,
        incarnation: "global-other",
        agentId: "other",
      }),
      policy: { mode: "followup" },
    });
    const capture = captureChannelSessionStop({
      key: globalKey,
      storePath,
      agentId: "other",
    });
    const outcome = await stopSession({ source: "restart", capture: capture.controller }).completed;
    expect(other.abortSignal.aborted).toBe(true);
    expect(active.abortSignal.aborted).toBe(false);
    expect(outcome.activeCancelled).toBe(0);
  } finally {
    release.resolve();
    active.complete();
    if (other) {
      retireSessionControllerInput(other);
    }
    await mutation;
  }
});
