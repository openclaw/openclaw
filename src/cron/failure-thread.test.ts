import { describe, expect, it } from "vitest";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { CronConfig } from "../config/types.cron.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveFailureAlert } from "./service/failure-alerts.js";
import type { CronDelivery, CronJob } from "./types.js";

const target = { channel: "telegram", to: "-100123456789" };
const route = { ...target, threadId: 41 };
const primary: CronDelivery = { mode: "announce", ...target, threadId: 7 };
const alert = (
  cronConfig: CronConfig = {},
  overrides: Partial<CronJob> & { createdActor?: SessionCreatedActor } = {},
) =>
  resolveFailureAlert(
    { deps: { cronConfig, defaultAgentId: "main" } },
    makeCronJob({ agentId: "ops", delivery: primary, ...overrides }),
  );

it("uses the result topic unless global failure policy selects another topic", () => {
  expect(alert()).toMatchObject({ ...primary, alternateRoute: false });
  expect(alert({ failureAlert: route })).toMatchObject({ ...route, alternateRoute: true });
  expect(alert({ failureAlert: { ...target, threadId: "7" } })?.alternateRoute).toBe(false);
  expect(alert({ failureAlert: { to: "-100123456789:topic:20" } })).toMatchObject({
    to: "-100123456789:topic:20",
    threadId: undefined,
  });
});
