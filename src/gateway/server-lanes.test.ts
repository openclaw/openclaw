import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getBackgroundWorkSnapshot } from "../process/background-work.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";

const applyConfig = (config: OpenClawConfig, gatewayStart = false) =>
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config), { gatewayStart });

afterEach(async () => {
  // Startup drains this process-global state; isolate subsequent lane assertions.
  const { resetSessionSuspensionStateForTest } =
    await import("../agents/session-suspension.test-support.js");
  resetSessionSuspensionStateForTest();
  resetCommandQueueStateForTest();
});

it("restores interrupted work at the configured agent concurrency without consuming interactive slots", async () => {
  applyConfig({ agents: { defaults: { maxConcurrent: 6 } } }, true);
  const release = createDeferred();
  const started: number[] = [];
  const runs = Array.from({ length: 7 }, (_, index) =>
    enqueueCommandInLane(CommandLane.RestartRecovery, async () => {
      started.push(index);
      await release.promise;
    }),
  );
  try {
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5]));
    expect(getCommandLaneSnapshot(CommandLane.RestartRecovery)).toMatchObject({
      activeCount: 6,
      queuedCount: 1,
      maxConcurrent: 6,
    });
    await expect(enqueueCommandInLane(CommandLane.Main, async () => "interactive")).resolves.toBe(
      "interactive",
    );
    applyConfig({ agents: { defaults: { maxConcurrent: 2 } } });
    expect(getCommandLaneSnapshot(CommandLane.RestartRecovery).maxConcurrent).toBe(2);
    expect(started).toHaveLength(6);
  } finally {
    release.resolve();
    await Promise.all(runs);
  }
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
});

it("restores the suspended shared nested lane to its default concurrency on startup", async () => {
  setCommandLaneConcurrency(CommandLane.Nested, 0);
  applyConfig({}, true);
  const releaseRuns = createDeferred();
  const run = vi.fn(() => releaseRuns.promise);
  const first = enqueueCommandInLane(CommandLane.Nested, run, { warnAfterMs: 10_000 });
  const second = enqueueCommandInLane(CommandLane.Nested, run, { warnAfterMs: 10_000 });
  await Promise.resolve();
  expect(run).toHaveBeenCalledOnce();
  releaseRuns.resolve();
  await Promise.all([first, second]);
  expect(run).toHaveBeenCalledTimes(2);
});

it("does not resume a suspended shared nested lane during live config publication", async () => {
  setCommandLaneConcurrency(CommandLane.Nested, 0);
  applyConfig({});
  const run = vi.fn(async () => {});
  const nestedRun = enqueueCommandInLane(CommandLane.Nested, run, { warnAfterMs: 10_000 });
  await Promise.resolve();
  expect(run).not.toHaveBeenCalled();
  setCommandLaneConcurrency(CommandLane.Nested, 1);
  await nestedRun;
  expect(run).toHaveBeenCalledOnce();
});

it("bounds recall helpers across sessions to the configured child limit", async () => {
  const limit = 2;
  applyConfig({ agents: { defaults: { subagents: { maxConcurrent: limit } } } }, true);
  const release = createDeferred();
  const started: number[] = [];
  const runs = Array.from({ length: limit + 2 }, (_, index) =>
    enqueueCommandInLane(`test:recall-parent-${index}`, () =>
      enqueueCommandInLane("active-memory", async () => {
        started.push(index);
        await release.promise;
      }),
    ),
  );
  try {
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    expect(getCommandLaneSnapshot("active-memory")).toMatchObject({
      activeCount: limit,
      queuedCount: 2,
      maxConcurrent: limit,
    });
  } finally {
    release.resolve();
    await Promise.all(runs);
  }
  expect(started).toEqual([0, 1, 2, 3]);
});

it("keeps recall capacity separate from a parent occupying the child lane", async () => {
  applyConfig({ agents: { defaults: { subagents: { maxConcurrent: 1 } } } });
  const release = createDeferred();
  const helper = vi.fn(() => release.promise);
  const siblingRun = vi.fn(async () => {});
  const parent = enqueueCommandInLane(CommandLane.Subagent, () =>
    enqueueCommandInLane("active-memory", helper),
  );
  const sibling = enqueueCommandInLane(CommandLane.Subagent, siblingRun);
  try {
    await vi.waitFor(() => expect(helper).toHaveBeenCalledOnce());
    expect(siblingRun).not.toHaveBeenCalled();
    expect(getCommandLaneSnapshot(CommandLane.Subagent)).toMatchObject({
      activeCount: 1,
      queuedCount: 1,
    });
  } finally {
    release.resolve();
    await Promise.all([parent, sibling]);
  }
  expect(siblingRun).toHaveBeenCalledOnce();
});

it("applies recall cap changes without releasing occupied capacity or reordering waiters", async () => {
  const applyLimit = (maxConcurrent: number) =>
    applyConfig({ agents: { defaults: { subagents: { maxConcurrent } } } });
  applyLimit(2);
  const gates = Array.from({ length: 4 }, () => createDeferred());
  const started: number[] = [];
  const runs = gates.map((gate, index) =>
    enqueueCommandInLane("active-memory", async () => {
      started.push(index);
      await gate.promise;
    }),
  );
  try {
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    applyLimit(1);
    expect(getCommandLaneSnapshot("active-memory")).toMatchObject({
      activeCount: 2,
      queuedCount: 2,
      maxConcurrent: 1,
    });
    gates[0]!.resolve();
    await runs[0];
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve();
    await runs[1];
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    applyLimit(2);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
  } finally {
    gates.forEach((gate) => gate.resolve());
    await Promise.all(runs);
  }
  expect(getCommandLaneSnapshot("active-memory")).toMatchObject({
    activeCount: 0,
    queuedCount: 0,
    maxConcurrent: 2,
  });
});

it("preserves shared background capacity across gateway lane publication", async () => {
  const lane = "background:plugin:reload-test";
  publishLaneConfiguration({
    lanes: { [lane]: 3 },
    groups: { "background-work": { budget: 3, members: [lane] } },
  });
  const gates = Array.from({ length: 3 }, () => createDeferred());
  const active = gates.map((gate) =>
    enqueueCommandInLane(lane, async () => await gate.promise, {
      priority: "background",
    }),
  );
  const nextRun = vi.fn(async () => {});
  const next = enqueueCommandInLane(lane, nextRun, { priority: "background" });
  try {
    applyConfig({ hooks: { enabled: true } });
    applyConfig({ hooks: { enabled: false } });
    expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 3, queuedCount: 1 });
    expect(nextRun).not.toHaveBeenCalled();
  } finally {
    gates.forEach((gate) => gate.resolve());
    await Promise.all([...active, next]);
  }
  expect(nextRun).toHaveBeenCalledOnce();
});
