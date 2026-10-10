import { expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { prepareCronNotificationRouting } from "./notification-intents.js";

it("does not require a default owner when the caller does not attach routing", () => {
  const job = makeCronJob({ agentId: undefined, sessionKey: undefined });
  const resolveDefaultAgentId = vi.fn(() => {
    throw new Error("unneeded default lookup");
  });
  const policy = prepareCronNotificationRouting({ resolveDefaultAgentId }, false, [job]);
  expect(policy.routing).toEqual({});
  expect(() =>
    policy.assertCurrent([{ kind: "auto-disabled", job, text: "disabled" }]),
  ).not.toThrow();
  expect(resolveDefaultAgentId).not.toHaveBeenCalled();
});
