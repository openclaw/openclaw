import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryCronScheduleIdentity } from "../../cron/schedule-identity.js";
import { saveCronJobsStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { listTaskFlowAutomationObligationsForCronJobFromSqlite } from "../../tasks/task-flow-automation-obligation.store.sqlite.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";

let storePath: string;
let runId: string;
let job: CronJob;
let paused = false;
const ownerKey = "agent:main:main";
const controllerId = "tests/automation-obligation";

beforeEach(async () => {
  installRuntimeTaskDeliveryMock();
  paused = false;
  storePath = path.join(os.tmpdir(), `obligation-${randomUUID()}`, "jobs.json");
  runId = randomUUID();
  job = {
    id: randomUUID(),
    name: "paced work",
    enabled: true,
    agentId: "main",
    sessionKey: ownerKey,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "every", everyMs: 86_400_000 },
    pacing: { min: "15m", max: "24h" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Inspect current work" },
    state: {},
  };
  await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
  const identity = tryCronScheduleIdentity(job);
  if (!identity) {
    throw new Error("expected valid schedule");
  }
  claimAgentRunContext(runId, {
    cronRunsByJobId: new Map([
      [
        job.id,
        {
          pacingEnabled: true,
          scheduledAutomation: true,
          cronStoreKey: cronStoreKey(storePath),
          cronScheduleIdentity: identity,
        },
      ],
    ]),
  });
});

afterEach(async () => {
  clearAgentRunContext(runId);
  await resetRuntimeTaskTestState();
  await saveCronJobsStore(storePath, { version: 1, jobs: [] });
});

function bound() {
  return createRuntimeTaskFlow().fromToolContext({
    sessionKey: ownerKey,
    sessionId: "persistent-conversation",
    runId,
    getRuntimeConfig: () => ({ cron: { enabled: !paused } }),
  });
}
function trigger(delay = 1_800_000) {
  return { triggerAtMs: Date.now() + delay, triggerKind: "check", triggerDigest: "a".repeat(64) };
}
function receipts() {
  return listTaskFlowAutomationObligationsForCronJobFromSqlite(openOpenClawStateDatabase().db, {
    cronStoreKey: cronStoreKey(storePath),
    cronJobId: job.id,
  });
}

describe("current Automation atomic managed Flow contract", () => {
  it("commits history and two Flow obligations with the earliest unchanged paced timestamp", () => {
    const flows = bound();
    const history = flows.registerHistoryController({ controllerId });
    const first = history.createManagedWithCurrentAutomationObligation({
      flow: { goal: "first", status: "waiting" },
      obligation: trigger(),
    });
    const second = history.createManagedWithCurrentAutomationObligation({
      flow: { goal: "second", status: "waiting" },
      obligation: trigger(3_600_000),
    });
    expect(second.nextRunAtMs).toBe(first.nextRunAtMs);
    expect(receipts()).toHaveLength(2);
    expect(history.list({ flowId: first.flow.flowId }).events).toHaveLength(1);
    const ordinary = flows.setWaiting({
      flowId: first.flow.flowId,
      expectedRevision: first.flow.revision,
      stateJson: { delivery: "recorded" },
    });
    expect(ordinary.applied).toBe(true);
    expect(receipts()[0]?.scheduledAtMs).toBe(first.nextRunAtMs);
    expect(
      createRuntimeTaskFlow()
        .bindSession({ sessionKey: "agent:other:main" })
        .get(first.flow.flowId),
    ).toBeUndefined();
  });

  it("rolls back Flow and history when receipt validation fails after the Flow write", () => {
    const flows = bound();
    const history = flows.registerHistoryController({ controllerId });
    const before = history.list().events.length;
    expect(() =>
      history.createManagedWithCurrentAutomationObligation({
        flow: { goal: "must roll back", status: "waiting" },
        obligation: { ...trigger(), triggerDigest: "invalid" },
      }),
    ).toThrow();
    expect(flows.list()).toHaveLength(0);
    expect(history.list().events).toHaveLength(before);
    expect(receipts()).toHaveLength(0);
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT count(*) AS n FROM flow_runs WHERE controller_id=?")
        .get(controllerId)?.n,
    ).toBe(0);
  });

  it("rejects stale, paused, disabled and terminal mutations without replacing the receipt", async () => {
    const flows = bound();
    const created = flows.createManagedWithCurrentAutomationObligation({
      flow: { controllerId, goal: "protected", status: "waiting" },
      obligation: trigger(),
    });
    const mutate = (revision = created.flow.revision) =>
      flows.commitWithCurrentAutomationObligation({
        flowId: created.flow.flowId,
        expectedRevision: revision,
        mutation: { kind: "resume" },
        obligation: trigger(),
      });
    expect(() => mutate(created.flow.revision + 1)).toThrow();
    paused = true;
    expect(() => mutate()).toThrow();
    paused = false;
    await saveCronJobsStore(storePath, { version: 1, jobs: [{ ...job, enabled: false }] });
    expect(() => mutate()).toThrow();
    expect(receipts()[0]?.obligationId).toBe(created.obligationId);
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    const terminal = flows.finish({
      flowId: created.flow.flowId,
      expectedRevision: created.flow.revision,
    });
    expect(terminal.applied).toBe(true);
    expect(receipts()).toHaveLength(0);
    if (!terminal.applied) {
      throw new Error("expected finish");
    }
    expect(() => mutate(terminal.flow.revision)).toThrow();
  });
});
