import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import {
  bindSessionSendDeliveryContext,
  readSessionSendDelivery,
  readSessionSendDeliveryAdmission,
  withSessionSendDelivery,
  type SessionSendDelivery,
} from "./session-send-delivery.js";

const delivery: SessionSendDelivery = {
  version: 1,
  runId: "send-1",
  source: { agentId: "main", sessionKey: "agent:main:dashboard:source", sessionId: "source-id" },
  target: { agentId: "main", sessionKey: "agent:main:dashboard:target", sessionId: "target-id" },
  sandboxed: false,
  message: "peer update",
};

describe("durable peer input identity", () => {
  it("binds private admission to the exact target and run only", () => {
    const target = {
      agentId: "main",
      sessionKey: delivery.target.sessionKey,
      sessionId: "target-id",
      runId: "send-1",
    };
    const originalCaller = AsyncLocalStorage.snapshot();
    expect(readSessionSendDeliveryAdmission(target)).toBeUndefined();
    withSessionSendDelivery({ delivery }, () => {
      expect(originalCaller(() => readSessionSendDeliveryAdmission(target))).toBeUndefined();
      expect(
        originalCaller(
          bindSessionSendDeliveryContext(() => readSessionSendDeliveryAdmission(target)),
        )?.delivery,
      ).toBe(delivery);
      expect(readSessionSendDeliveryAdmission(target)?.delivery).toBe(delivery);
      expect(
        readSessionSendDeliveryAdmission({ ...target, sessionId: "replacement" }),
      ).toBeUndefined();
      expect(readSessionSendDeliveryAdmission({ ...target, runId: "descendant" })).toBeUndefined();
    });
    expect(readSessionSendDeliveryAdmission(target)).toBeUndefined();
  });

  it("requires matching retained provenance and original input identity", () => {
    const message = buildPersistedUserTurnMessage({
      text: "peer update",
      idempotencyKey: "send-1:user",
      provenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: delivery.source.sessionKey,
      },
    });
    const retained = {
      ...message,
      __openclaw: { ...message["__openclaw"], sessionSendDelivery: delivery },
    };
    expect(readSessionSendDelivery(retained)).toEqual(delivery);
    expect(readSessionSendDelivery(message)).toBeUndefined();
    expect(readSessionSendDelivery({ ...retained, idempotencyKey: "other:user" })).toBeUndefined();
    expect(
      readSessionSendDelivery({
        ...retained,
        provenance: { ...message.provenance!, sourceSessionKey: "other" },
      }),
    ).toBeUndefined();
  });
});
