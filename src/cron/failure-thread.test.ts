// Failure destinations accept explicit threads without changing legacy routes.
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { CronConfig } from "../config/types.cron.js";
import { resolveFailureDestination } from "./delivery-plan.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { normalizeCronJobPatch } from "./normalize.js";
import { mergeCronDelivery, mergeCronFailureAlert } from "./service/delivery-merge.js";
import { resolveFailureAlert } from "./service/failure-alerts.js";
import { deliveryToJson } from "./store/delivery-codec.js";
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

describe("failure destination threads", () => {
  it.each([
    ["global", { failureAlert: route }, {}],
    [
      "agent",
      { failureAlert: { ...route, threadId: 1 }, agents: { ops: { failureAlert: route } } },
      {},
    ],
    [
      "creator",
      {
        agents: { ops: { failureAlert: { ...route, threadId: 2 } } },
        creators: { alice: { failureAlert: route } },
      },
      { createdActor: { type: "human", source: "profile", id: "alice" } },
    ],
    ["job", { failureAlert: { ...route, threadId: 3 } }, { failureAlert: route }],
    ["delivery", {}, { delivery: { ...primary, failureDestination: route } }],
  ] as const)("uses the %s thread instead of the primary thread", (_name, config, job) => {
    expect(alert(config, job)).toMatchObject({ ...route, alternateRoute: true });
  });

  it("does not inherit a thread from a different scoped destination", () => {
    expect(
      alert({
        failureAlert: route,
        agents: { ops: { failureAlert: { channel: "slack", to: "C1" } } },
      }),
    ).toMatchObject({ channel: "slack", to: "C1", threadId: undefined });
  });

  it.each([
    [{ to: "other" }, undefined],
    [{ accountId: "another-bot" }, undefined],
    [{ channel: "slack", to: "C1" }, undefined],
    [{ mode: "webhook", to: "https://example.com/notify" }, undefined],
    [{ to: "other", threadId: 42 }, 42],
    [{ threadId: undefined }, undefined],
  ] as const)("does not carry a thread across a route change: %j", (override, expected) => {
    const job = makeCronJob({ delivery: { ...primary, failureDestination: override } });
    expect(resolveFailureDestination(job, route)?.threadId).toBe(expected);
  });

  it("deduplicates the same explicit thread but not another topic", () => {
    expect(alert({ failureAlert: { ...target, threadId: "7" } })?.alternateRoute).toBe(false);
    expect(alert({ failureAlert: route })?.alternateRoute).toBe(true);
  });

  it("keeps the creating conversation route when no new defaults are configured", () => {
    expect(alert()).toMatchObject({ ...target, threadId: 7, alternateRoute: false });
    expect(alert({}, { failureAlert: false })).toBeNull();
    expect(alert({}, { delivery: { mode: "none" } })).toBeNull();
  });

  it("keeps legacy encoded Telegram topics untouched", () => {
    const encoded = { channel: "telegram", to: "-100123456789:topic:41" };
    expect(alert({ failureAlert: encoded })).toMatchObject({ ...encoded, threadId: undefined });
  });

  it("normalizes, merges and persists explicit threads and clears", () => {
    const patch = normalizeCronJobPatch({ delivery: { failureDestination: { threadId: " 41 " } } });
    assert(patch);
    expect(patch.delivery?.failureDestination?.threadId).toBe("41");
    const delivery = mergeCronDelivery(primary, { failureDestination: route }, "announce");
    assert(delivery);
    expect(deliveryToJson(delivery).failureDestination).toMatchObject(route);
    const cleared = mergeCronDelivery(
      delivery,
      { failureDestination: { threadId: null } },
      "announce",
    );
    assert(cleared);
    expect(cleared.failureDestination).toMatchObject({ ...target, threadId: undefined });
    expect(deliveryToJson(cleared).failureDestination).toMatchObject({ threadId: null });
    expect(mergeCronFailureAlert(route, { threadId: null })).toMatchObject({ threadId: undefined });
    expect(mergeCronFailureAlert(undefined, { threadId: 42 })).toMatchObject({ threadId: 42 });
  });
});
