import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
  bindSessionSendDeliveryContext,
  readSessionSendDeliveryAdmission,
  withSessionSendDelivery,
} from "./session-send-delivery.js";

const delivery: Parameters<typeof withSessionSendDelivery>[0]["delivery"] = {
  version: 1,
  runId: "send-1",
  source: { agentId: "main", sessionKey: "agent:main:dashboard:source", sessionId: "source-id" },
  target: { agentId: "main", sessionKey: "agent:main:dashboard:target", sessionId: "target-id" },
  sandboxed: false,
  message: "peer update",
};

describe("live peer input identity", () => {
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
});
