import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { admitModelTurn } from "../agents/bash-tools.lifecycle.test-support.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { openEventToolHost } from "../auto-reply/reply/session-event.test-support.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  failureAlertModel,
  setupFailureAlertNotificationFixture as setupFixture,
} from "./service.failure-alert-notifications.test-support.js";

const sessionKey = "agent:main:main";
const sessionId = "failure-alert-fallback-session";
const ordinaryInboundText = "Ordinary inbound message.";
const handoffResultPrefix = "Plugin reload result:";
const route: DeliveryContext = { channel: "telegram", to: "999", accountId: "default" };
const fixtureOptions = {
  agentId: "main",
  sessionKey,
  sessionId,
  sessionDeliveryContext: route,
  telegram: true,
} as const;

const scenarios = [
  {
    name: "keeps an owner no-route fallback in the session",
    delivery: { mode: "announce", target: "owner" },
    response: "reply",
  },
  {
    name: "does not derive an external target for an implicit message send",
    delivery: { mode: "announce", target: "owner" },
    response: "message-tool",
  },
  {
    name: "does not silence the next ordinary inbound turn",
    delivery: { mode: "announce", target: "owner" },
    response: "ordinary-flow",
  },
  {
    name: "An owner blocked authentication error stays in the session.",
    delivery: { mode: "announce", target: "owner", directPolicy: "block" },
    response: "error",
  },
  {
    name: "A non-owner fallback still delivers to the configured conversation.",
    delivery: { mode: "announce", channel: "telegram", to: "999" },
    response: "reply",
  },
  {
    name: "A blocked non-owner fallback stays in the session.",
    delivery: { mode: "announce", channel: "telegram", to: "999", directPolicy: "block" },
    response: "reply",
  },
] as const;

describe("CronService rejected failure-alert fallback", { concurrent: false }, () => {
  for (const scenario of scenarios) {
    it(scenario.name, async ({ signal }) => {
      await withOpenClawTestState(
        { label: "cron-failure-alert-fallback", env: { OPENCLAW_TEST_FAST: "0" } },
        async (state) => {
          const fixture = await setupFixture(state, fixtureOptions);
          let messageToolError: unknown;
          try {
            failureAlertModel.mockReset().mockImplementation(async (params) => {
              if (params.prompt.includes(ordinaryInboundText)) {
                await admitModelTurn(params);
                return { payloads: [{ text: "Ordinary reply." }], meta: { durationMs: 1 } };
              }
              if (scenario.response === "message-tool") {
                const { tools, close } = await openEventToolHost(params, "failure alert fallback", {
                  includeOpenClawTools: true,
                });
                try {
                  const message = expectDefined(
                    tools.find((tool) => tool.name === "message"),
                    "message tool",
                  );
                  await message.execute("implicit-send", {
                    action: "send",
                    message: "Fallback progress.",
                  });
                } catch (error) {
                  messageToolError = error;
                  throw error;
                } finally {
                  close();
                }
                return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
              }
              await admitModelTurn(params);
              return {
                payloads:
                  scenario.response === "error"
                    ? [{ text: "Authentication failed.", isError: true }]
                    : [{ text: "Fallback reply." }],
                meta: { durationMs: 1 },
              };
            });
            await fixture.run({ delivery: scenario.delivery }, signal);
            const outcome = await withinTest(
              expectDefined(fixture.receipts[0], "fallback receipt").settled,
              signal,
            );
            expect(outcome.status).toBe(
              scenario.response === "error" || scenario.response === "message-tool"
                ? "failed"
                : "completed",
            );
            expect(fixture.sendText.mock.calls.map(([sent]) => sent.text)).toEqual(
              scenario.response === "reply" &&
                !("target" in scenario.delivery) &&
                !("directPolicy" in scenario.delivery)
                ? ["Fallback reply."]
                : [],
            );
            if (scenario.response === "reply" && "target" in scenario.delivery) {
              const transcriptText = JSON.stringify(
                await loadTranscriptEvents({ agentId: "main", sessionKey, sessionId }),
              );
              expect(transcriptText).toContain("Important report");
              expect(transcriptText).toContain("failed 1 times");
              expect(outcome.summary).toBe("Fallback reply.");
            }
            if (scenario.response === "message-tool") {
              expect(String(messageToolError)).toContain(
                "Action send requires a target. This turn has no current conversation; pass an explicit target, or reply in normal text.",
              );
            }
            if (scenario.response === "ordinary-flow") {
              const ordinary = sessionEvents.enqueueSessionEventForHost(ordinaryInboundText, {
                agentId: "main",
                sessionKey,
                source: "session",
                deliveryContext: route,
              });
              await withinTest(ordinary.settled, signal);
              expect(fixture.sendText.mock.calls[0]?.[0]).toMatchObject({
                to: "999",
                text: "Ordinary reply.",
              });
            }
          } finally {
            await fixture.close();
          }
        },
      );
    });
  }

  it("A fallback-derived session event stays in the session.", async ({ signal }) => {
    await withOpenClawTestState(
      { label: "cron-failure-alert-derived-event", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const fixture = await setupFixture(state, fixtureOptions);
        let derivedTarget: sessionEvents.SessionEventTarget | undefined;
        try {
          failureAlertModel.mockReset().mockImplementation(async (params) => {
            if (params.prompt.includes(handoffResultPrefix)) {
              await admitModelTurn(params);
              return { payloads: [{ text: "Derived reply." }], meta: { durationMs: 1 } };
            }
            await admitModelTurn(params);
            derivedTarget = await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey,
                operationalRunInstance: createOperationalRunInstanceRef(params.runId),
                receiptAuthority: () => true,
              },
              () => sessionEvents.captureSessionEventTargetForHost("main", sessionKey),
            );
            return { payloads: [{ text: "Fallback reply." }], meta: { durationMs: 1 } };
          });
          await fixture.run({ delivery: { mode: "announce", target: "owner" } }, signal);
          await withinTest(expectDefined(fixture.receipts[0], "fallback receipt").settled, signal);
          const expectedTarget = expectDefined(derivedTarget, "fallback-derived target");
          const derivedReceipt = sessionEvents.enqueueSessionEventForHost(
            `${handoffResultPrefix} Derived event.`,
            {
              agentId: "main",
              sessionKey,
              source: "tool_handoff",
              contextKey: "failure-alert-derived-event",
              expectedTarget,
            },
          );
          expect(fixture.receipts).toHaveLength(2);
          const derivedOutcome = await withinTest(derivedReceipt.settled, signal);
          expect(expectedTarget.deliver).toBe(false);
          expect(derivedOutcome).toMatchObject({
            status: "completed",
            executionStarted: true,
            delivered: false,
            deliveryAttempted: false,
            summary: "Derived reply.",
          });
          expect(failureAlertModel).toHaveBeenCalledTimes(2);
          expect(failureAlertModel.mock.calls[1]?.[0].prompt).toContain(handoffResultPrefix);
          expect(fixture.sendText).not.toHaveBeenCalled();
        } finally {
          await fixture.close();
        }
      },
    );
  });
});
