// Cron default destination tests cover the global/agent/creator/explicit precedence matrix.
import { describe, expect, it } from "vitest";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { CronConfig } from "../config/types.cron.js";
import { resolveCronDeliveryDefaultsScope } from "./delivery-defaults.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveFailureAlert } from "./service/failure-alerts.js";
import type { CronDelivery } from "./types.js";

const globalDelivery = { channel: "telegram", to: "-100123456789", threadId: 1 };
const agentDelivery = { channel: "slack", to: "channel:C123", accountId: "work" };
const globalOnly: CronConfig = { delivery: globalDelivery };
const agentOnly: CronConfig = { agents: { ops: { delivery: agentDelivery } } };
const both: CronConfig = { ...globalOnly, ...agentOnly };

function plan(cronConfig: CronConfig | undefined, delivery?: CronDelivery, agentId = "ops") {
  return resolveCronDeliveryPlan(makeCronJob({ delivery }), { cronConfig, agentId });
}

describe("cron default delivery destination", () => {
  it.each([
    ["global only", globalOnly, "ops", { channel: "telegram", to: "-100123456789", threadId: 1 }],
    ["agent only", agentOnly, "ops", { channel: "slack", to: "channel:C123", accountId: "work" }],
    ["both, agent wins whole", both, "ops", { ...agentDelivery, threadId: undefined }],
    ["both, other agent uses global", both, "main", { ...globalDelivery, accountId: undefined }],
    [
      "agent key normalizes",
      { agents: { OPS: { delivery: agentDelivery } } },
      "ops",
      agentDelivery,
    ],
  ])("routes a route-less announce job: %s", (_name, cronConfig, agentId, expected) => {
    expect(
      plan(cronConfig, { mode: "announce", channel: "last" }, agentId as string),
    ).toMatchObject({
      mode: "announce",
      source: "delivery",
      requested: true,
      ...expected,
    });
  });

  it("applies to every session target", () => {
    for (const sessionTarget of ["isolated", "current", "main"] as const) {
      expect(
        resolveCronDeliveryPlan(makeCronJob({ sessionTarget, delivery: { mode: "announce" } }), {
          cronConfig: globalOnly,
          agentId: "ops",
        }),
      ).toMatchObject({ mode: "announce", channel: "telegram", to: "-100123456789", threadId: 1 });
    }
  });

  it("follows the implicit mode of jobs without a delivery object", () => {
    const resolveFor = (sessionTarget: "isolated" | "main") =>
      resolveCronDeliveryPlan(makeCronJob({ sessionTarget, delivery: undefined }), {
        cronConfig: globalOnly,
        agentId: "ops",
      });
    expect(resolveFor("isolated")).toMatchObject({ mode: "announce", channel: "telegram" });
    expect(resolveFor("main")).toEqual(
      resolveCronDeliveryPlan(makeCronJob({ sessionTarget: "main", delivery: undefined })),
    );
  });

  it.each<[string, CronDelivery]>([
    ["channel", { mode: "announce", channel: "discord" }],
    ["to", { mode: "announce", to: "telegram:42" }],
    ["threadId", { mode: "announce", threadId: 7 }],
    ["accountId", { mode: "announce", accountId: "alt" }],
    ["owner target", { mode: "announce", target: "owner" }],
  ])("keeps an explicit per-job %s over every default", (_name, delivery) => {
    expect(plan(both, delivery)).toEqual(plan(undefined, delivery));
  });

  it.each<[string, CronDelivery]>([
    ["none", { mode: "none" }],
    ["webhook", { mode: "webhook", to: "https://example.invalid/hook" }],
  ])("never gives mode=%s a chat destination", (_name, delivery) => {
    expect(plan(both, delivery)).toEqual(plan(undefined, delivery));
  });

  it("leaves route-less jobs unchanged when no default is configured", () => {
    const delivery: CronDelivery = { mode: "announce", channel: "last" };
    expect(plan({}, delivery)).toEqual(resolveCronDeliveryPlan(makeCronJob({ delivery })));
    expect(plan({ agents: { other: { delivery: agentDelivery } } }, delivery)).toEqual(
      resolveCronDeliveryPlan(makeCronJob({ delivery })),
    );
  });
});

describe("cron default failure-alert route", () => {
  const globalAlert = {
    after: 3,
    cooldownMs: 5_000,
    channel: "telegram",
    to: "-100123456789:topic:1",
  };
  const agentAlert = { channel: "slack", to: "channel:C999", accountId: "work" };
  const resolve = (
    cronConfig: CronConfig,
    job: Parameters<typeof resolveFailureAlert>[1],
    defaultAgentId = "main",
  ) => resolveFailureAlert({ deps: { cronConfig, defaultAgentId } }, job);

  it("uses the global route when the owner agent has none", () => {
    expect(
      resolve({ failureAlert: globalAlert }, { agentId: "ops", delivery: { mode: "none" } }),
    ).toMatchObject({
      after: 3,
      cooldownMs: 5_000,
      channel: "telegram",
      to: "-100123456789:topic:1",
    });
  });

  it("replaces the global route whole with the owner agent route and keeps global tuning", () => {
    expect(
      resolve(
        { failureAlert: globalAlert, agents: { ops: { failureAlert: agentAlert } } },
        { agentId: "ops", delivery: { mode: "none" } },
      ),
    ).toMatchObject({
      after: 3,
      cooldownMs: 5_000,
      channel: "slack",
      to: "channel:C999",
      accountId: "work",
    });
  });

  it("selects the agent route by session-key owner and default agent", () => {
    const cronConfig = { failureAlert: globalAlert, agents: { ops: { failureAlert: agentAlert } } };
    expect(
      resolve(cronConfig, {
        sessionKey: "agent:ops:telegram:direct:1",
        delivery: { mode: "none" },
      }),
    ).toMatchObject({ channel: "slack", to: "channel:C999" });
    expect(resolve(cronConfig, { delivery: { mode: "none" } }, "ops")).toMatchObject({
      channel: "slack",
    });
    expect(resolve(cronConfig, { delivery: { mode: "none" } })).toMatchObject({
      channel: "telegram",
    });
  });

  it("keeps an explicit per-job failure route over agent and global routes", () => {
    expect(
      resolve(
        { failureAlert: globalAlert, agents: { ops: { failureAlert: agentAlert } } },
        {
          agentId: "ops",
          delivery: { mode: "none" },
          failureAlert: { channel: "discord", to: "channel:42" },
        },
      ),
    ).toMatchObject({ channel: "discord", to: "channel:42" });
  });

  it("still honors a global enabled=false for inherited agent routes", () => {
    expect(
      resolve(
        { failureAlert: { enabled: false }, agents: { ops: { failureAlert: agentAlert } } },
        { agentId: "ops", delivery: { mode: "none" } },
      ),
    ).toBeNull();
  });

  it("falls back to the primary default destination when no failure route exists", () => {
    expect(
      resolve(
        { delivery: globalDelivery },
        { agentId: "ops", delivery: { mode: "announce", channel: "last" } },
      ),
    ).toMatchObject({ mode: "announce", channel: "telegram", to: "-100123456789", threadId: 1 });
  });

  it("uses the primary default for implicit announce failures", () => {
    expect(
      resolve(
        { delivery: globalDelivery },
        makeCronJob({ agentId: "ops", sessionTarget: "isolated", delivery: undefined }),
      ),
    ).toMatchObject({ mode: "announce", channel: "telegram", to: "-100123456789", threadId: 1 });
  });

  it("resolves primary and failure defaults independently", () => {
    const cronConfig: CronConfig = {
      delivery: globalDelivery,
      agents: { ops: { failureAlert: agentAlert } },
    };
    expect(plan(cronConfig, { mode: "announce" })).toMatchObject({ channel: "telegram" });
    expect(resolve(cronConfig, { agentId: "ops", delivery: { mode: "announce" } })).toMatchObject({
      channel: "slack",
      to: "channel:C999",
    });
  });

  it("stays quiet with no defaults and no route", () => {
    expect(resolve({}, { agentId: "ops", delivery: { mode: "none" } })).toBeNull();
  });
});

describe("cron creator-profile defaults", () => {
  const creatorDelivery = { channel: "discord", to: "user:111", accountId: "home" };
  const creatorAlert = { channel: "discord", to: "user:111" };
  const agentAlert = { channel: "slack", to: "channel:C999", accountId: "work" };
  const cronConfig: CronConfig = {
    delivery: globalDelivery,
    failureAlert: { after: 2, cooldownMs: 9_000, channel: "telegram", to: "-100123456789" },
    agents: { ops: { delivery: agentDelivery, failureAlert: agentAlert } },
    creators: { alice: { delivery: creatorDelivery, failureAlert: creatorAlert } },
  };
  const alice: SessionCreatedActor = { type: "human", source: "profile", id: "alice" };
  const scopedPlan = (createdActor: SessionCreatedActor | undefined, delivery?: CronDelivery) => {
    const job = makeCronJob({ agentId: "ops", delivery: delivery ?? { mode: "announce" } });
    return resolveCronDeliveryPlan(
      job,
      resolveCronDeliveryDefaultsScope(cronConfig, { ...job, createdActor }, "main"),
    );
  };
  const alert = (createdActor: SessionCreatedActor | undefined, config = cronConfig) =>
    resolveFailureAlert(
      { deps: { cronConfig: config, defaultAgentId: "main" } },
      { agentId: "ops", delivery: { mode: "none" }, createdActor },
    );

  it("routes a route-less announce job to its human creator's default over agent and global", () => {
    expect(scopedPlan(alice)).toMatchObject({
      mode: "announce",
      channel: "discord",
      to: "user:111",
      accountId: "home",
      threadId: undefined,
    });
  });

  it("applies the creator default when only the creator has one", () => {
    const job = makeCronJob({ delivery: { mode: "announce" } });
    expect(
      resolveCronDeliveryPlan(
        job,
        resolveCronDeliveryDefaultsScope(
          { creators: { alice: { delivery: creatorDelivery } } },
          { ...job, createdActor: alice },
          "main",
        ),
      ),
    ).toMatchObject({ mode: "announce", channel: "discord", to: "user:111" });
  });

  it("attributes an agent-created job to the human profile that delegated it", () => {
    expect(
      scopedPlan({
        type: "agent",
        id: "ops",
        delegatedBy: { type: "human", source: "profile", id: "alice" },
      }),
    ).toMatchObject({ channel: "discord", to: "user:111" });
  });

  it.each<[string, SessionCreatedActor | undefined]>([
    ["legacy job without createdActor", undefined],
    ["channel-only human", { type: "human", source: "channel", id: "alice" }],
    ["unknown human", { type: "human", source: "unknown", id: "alice" }],
    ["agent", { type: "agent", id: "alice" }],
    ["system", { type: "system", id: "alice" }],
    ["other profile", { type: "human", source: "profile", id: "bob" }],
    ["profile id differing by case", { type: "human", source: "profile", id: "Alice" }],
  ])("gives no creator default to a %s", (_name, createdActor) => {
    expect(scopedPlan(createdActor)).toMatchObject({ channel: "slack", to: "channel:C123" });
    expect(alert(createdActor)).toMatchObject({ channel: "slack", to: "channel:C999" });
  });

  it.each<[string, CronDelivery]>([
    ["channel", { mode: "announce", channel: "telegram", to: "42" }],
    ["owner target", { mode: "announce", target: "owner" }],
    ["none", { mode: "none" }],
    ["webhook", { mode: "webhook", to: "https://example.invalid/hook" }],
  ])("keeps the job's own %s route over the creator default", (_name, delivery) => {
    expect(scopedPlan(alice, delivery)).toEqual(scopedPlan(undefined, delivery));
  });

  it("replaces agent and global failure routes with the creator route and keeps global tuning", () => {
    expect(alert(alice)).toMatchObject({
      after: 2,
      cooldownMs: 9_000,
      channel: "discord",
      to: "user:111",
      accountId: undefined,
    });
  });

  it("falls through to the owner agent failure route when the creator has only a delivery default", () => {
    expect(
      alert(alice, { ...cronConfig, creators: { alice: { delivery: creatorDelivery } } }),
    ).toMatchObject({ channel: "slack", to: "channel:C999" });
  });

  it("keeps an explicit per-job failure route over the creator route", () => {
    expect(
      resolveFailureAlert(
        { deps: { cronConfig, defaultAgentId: "main" } },
        {
          agentId: "ops",
          delivery: { mode: "none" },
          failureAlert: { channel: "telegram", to: "7" },
          createdActor: alice,
        },
      ),
    ).toMatchObject({ channel: "telegram", to: "7" });
  });
});
