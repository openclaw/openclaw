import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorPlan } from "./heartbeat-monitor.js";
import type { CronJob, CronJobCreate } from "./types.js";

function monitorJob(input: CronJobCreate, id = `job-${input.agentId}`): CronJob {
  return { ...input, id, createdAtMs: 1, updatedAtMs: 1, state: {} } as CronJob;
}

const options = { schedulerSeed: "test-seed" };
const defaultConfig: OpenClawConfig = { agents: { defaults: { heartbeat: { every: "15m" } } } };

function plannedInput(cfg: OpenClawConfig = defaultConfig, agentId = "main") {
  const input = resolveHeartbeatMonitorPlan(cfg, [], options).specs.find(
    (spec) => spec.agentId === agentId,
  )?.input;
  if (!input) {
    throw new Error("expected configured heartbeat monitor spec");
  }
  return input;
}

it("creates no monitor jobs for an ownerless explicit multi-agent roster", () => {
  const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {}, ops: {} } } };

  expect(resolveHeartbeatMonitorPlan(cfg, [], options).specs).toEqual([]);
});

it("plans changed monitors once without adopting colliding user jobs", () => {
  const cfg: OpenClawConfig = {
    agents: { ...defaultConfig.agents, entries: { main: {}, ops: {}, new: {} } },
  };
  const main = plannedInput(cfg);
  const ops = plannedInput(cfg, "ops");
  const jobs = [
    monitorJob(main),
    monitorJob({ ...ops, enabled: false }),
    monitorJob({ ...main, agentId: "stale", declarationKey: "heartbeat:stale" }),
    monitorJob({
      ...main,
      agentId: "collider",
      declarationKey: "heartbeat:collider",
      payload: { kind: "systemEvent", text: "user-owned" },
    }),
  ];

  const plan = resolveHeartbeatMonitorPlan(cfg, jobs, options);
  expect(plan.changes.map(({ kind, agentId }) => ({ kind, agentId }))).toEqual([
    { kind: "update", agentId: "ops" },
    { kind: "create", agentId: "new" },
    { kind: "remove", agentId: "stale" },
  ]);
});

it("retains a disabled monitor and its existing cadence", () => {
  const cfg: OpenClawConfig = { agents: { defaults: { heartbeat: { every: "0m" } } } };
  const input = plannedInput(cfg);
  const existing = monitorJob({
    ...input,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
  });

  const plan = resolveHeartbeatMonitorPlan(cfg, [existing], options);
  expect(plan.changes).toMatchObject([
    {
      kind: "update",
      agentId: "main",
      input: { enabled: false, schedule: { kind: "every", everyMs: 60_000 } },
    },
  ]);
});

it("removes duplicate monitors before updating the retained row", () => {
  const input = plannedInput();
  const older = monitorJob(input, "older");
  const newer = { ...monitorJob({ ...input, enabled: false }, "newer"), updatedAtMs: 2 };

  const plan = resolveHeartbeatMonitorPlan(defaultConfig, [older, newer], options);
  expect(plan.changes).toEqual([
    { kind: "remove", agentId: "main", job: older },
    expect.objectContaining({ kind: "update", agentId: "main" }),
  ]);
});

it.each([
  { field: "name", value: "stale-name", changes: ["update"] },
  { field: "agentId", value: "stale-agent", changes: ["update"] },
  { field: "sessionTarget", value: "isolated", changes: ["update"] },
  { field: "wakeMode", value: "now", changes: ["update"] },
  { field: "declarationKey", value: "heartbeat:stale", changes: ["create", "remove"] },
] as const)("repairs a monitor with drifted $field", ({ field, value, changes }) => {
  const input = plannedInput();

  const plan = resolveHeartbeatMonitorPlan(
    defaultConfig,
    [monitorJob({ ...input, [field]: value })],
    options,
  );

  expect(plan.changes.map((change) => change.kind)).toEqual(changes);
});
