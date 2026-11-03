import { expect, test, vi } from "vitest";
import { enqueueContinuationReturnDeliveries } from "../auto-reply/continuation/targeting.js";
import {
  captureSessionRecipientAuthority,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  isSessionRecipientAuthorityCurrentInWorker,
  withCurrentSessionRecipientAuthority,
} from "../config/sessions/session-recipient-authority-current.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { seedActiveMainSession } = setupGatewaySessionsTestHarness();

test.each(["new", "reset"] as const)(
  "gateway /%s preserves accepted recipient authority through return enqueue",
  async (reason) => {
    const { storePath } = await seedActiveMainSession();
    const gatewayStateDir = process.env.OPENCLAW_STATE_DIR;
    if (!gatewayStateDir) {
      throw new Error("gateway sessions harness did not isolate OPENCLAW_STATE_DIR");
    }
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionKey, storePath };
    const beforeReset = loadSessionEntry(scope);
    const recipientAuthority = await captureSessionRecipientAuthority(scope);
    const { performGatewaySessionReset } = await import("./session-reset-service.js");

    const reset = await performGatewaySessionReset({
      key: "main",
      reason,
      commandSource: "gateway:agent",
      workerPlacementContext: {},
    });

    expect(reset).toMatchObject({ ok: true, key: sessionKey });
    if (!reset.ok || !("entry" in reset)) {
      throw new Error(`gateway /${reason} did not return a replacement session entry`);
    }
    expect(reset.entry.lifecycleRevision).toEqual(expect.any(String));
    expect(reset.entry.lifecycleRevision).not.toBe(beforeReset?.lifecycleRevision);
    expect(loadSessionEntry(scope)?.lifecycleRevision).toBe(reset.entry.lifecycleRevision);
    expect(await isSessionRecipientAuthorityCurrentInWorker(scope, recipientAuthority)).toBe(true);

    const enqueueSessionDelivery = vi.fn(async () => `delivery-${reason}`);
    const enqueueSystemEvent = vi.fn(() => true);
    const requestContinuationWake = vi.fn();
    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: [sessionKey],
        text: "accepted delegate result",
        idempotencyKeyBase: `continuation-return:${reason}`,
        recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
        ownerAgentId: "main",
        wakeRecipients: true,
      },
      {
        enqueueSessionDelivery,
        enqueueSystemEvent,
        requestContinuationWake,
        withRecipientAuthority: (target, authority, decide) =>
          withCurrentSessionRecipientAuthority(
            [{ scope: { agentId: "main", sessionKey: target.sessionKey, storePath }, authority }],
            ([current]) => decide(Boolean(current)),
          ),
      },
    );

    expect(result).toEqual({
      enqueued: 1,
      delivered: 1,
      deliveryIds: [`delivery-${reason}`],
      deliveredSessionKeys: [sessionKey],
      heldSessionKeys: [],
      resetHeldSessionKeys: [],
      refusedSessionKeys: [],
    });
    expect(enqueueSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientAuthority,
        awaitPromptAdoption: true,
        sessionKey,
      }),
      // No explicit queue state dir: the delivery binds to the gateway's own state dir.
      expect.objectContaining({
        environment: expect.objectContaining({ OPENCLAW_STATE_DIR: gatewayStateDir }),
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(requestContinuationWake).toHaveBeenCalledOnce();
  },
);
