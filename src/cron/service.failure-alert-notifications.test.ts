import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { admitModelTurn } from "../agents/bash-tools.lifecycle.test-support.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  failureAlertModel,
  setupFailureAlertNotificationFixture,
} from "./service.failure-alert-notifications.test-support.js";

const target = "agent:ops:telegram:group:42:topic:77";
const otherConversation = "agent:ops:discord:channel:other";
const deliveryContext: DeliveryContext = { channel: "telegram", to: "-10042", threadId: 77 };

it.for([
  ["persistent target", `session:${target}`, otherConversation, "now", true],
  ["targeted next-heartbeat", "isolated", target, "next-heartbeat", true],
  ["default owner", "isolated", undefined, "now", false],
  ["deferred default owner", "isolated", undefined, "next-heartbeat", false],
] as const)(
  "routes a rejected failure alert to %s with scheduling disabled",
  async ([_name, sessionTarget, creationSessionKey, wakeMode, carriesOrigin], { signal }) => {
    await withOpenClawTestState(
      { label: "cron-failure-notification", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const agentId = carriesOrigin ? "ops" : "main";
        const expectedSessionKey = carriesOrigin ? target : "agent:main:main";
        const fixture = await setupFailureAlertNotificationFixture(state, {
          agentId,
          sessionKey: expectedSessionKey,
          sessionId: "failure-notification-session",
          originDeliveryContext: deliveryContext,
        });
        try {
          failureAlertModel.mockReset().mockImplementation(async (params) => {
            await admitModelTurn(params);
            return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
          });
          await fixture.run({ sessionTarget, sessionKey: creationSessionKey, wakeMode }, signal);

          expect(fixture.receipts).toHaveLength(1);
          await expect(withinTest(fixture.receipts[0]!.accepted, signal)).resolves.toEqual({
            ok: true,
          });
          await expect(withinTest(fixture.receipts[0]!.settled, signal)).resolves.toMatchObject({
            status: "completed",
            executionStarted: true,
          });
          expect(failureAlertModel).toHaveBeenCalledOnce();
          const turn = failureAlertModel.mock.calls[0]![0];
          expect(turn).toMatchObject({
            sessionKey: expectedSessionKey,
            trigger: "event",
          });
          expect(turn.prompt).toContain('Automation "Important report" failed 1 times');
          expect(turn.messageTo).toBe(carriesOrigin ? deliveryContext.to : undefined);
          expect(turn.messageThreadId).toBe(carriesOrigin ? deliveryContext.threadId : undefined);
          expect(fixture.deps.enqueueSystemEvent).not.toHaveBeenCalled();
          expect(peekSystemEventEntries(expectedSessionKey)).toEqual([]);
        } finally {
          await fixture.close();
        }
      },
    );
  },
);
