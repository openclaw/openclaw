import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { loadedCronStoreFromRows, loadCronRows } from "./store/row-codec.js";
import { makeCronStreamSandboxTarget } from "./stream-sandbox.test-support.js";
import type { CronJob, CronStoredJob } from "./types.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-config-revision-" });
const message = "Summarize the day";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "daily report",
    enabled: true,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message },
    delivery: { mode: "announce", channel: "telegram", to: "chat-1" },
    state: {},
    ...overrides,
  };
}

it.each([
  { sessionId: "replacement-session" },
  { lifecycleRevision: "replacement-generation" },
  { scopeKey: "different-sandbox" },
  { workspaceDir: "/other/workspace" },
  { configLabel: "changed-policy" },
  {
    operator: {
      profileId: "profile-ada",
      githubLogin: null,
      scopes: ["operator.write"],
      assignedRole: null,
      gatewayAccessGrant: { pluginId: "access", grantId: "replacement-grant" },
    },
  },
])("binds sandbox target and original authority changes: %j", (change) => {
  const job: CronStoredJob = {
    ...makeJob(),
    schedule: { kind: "stream", command: ["watch-source"] },
    streamSandbox: makeCronStreamSandboxTarget(),
  };
  expect(
    resolveCronJobConfigRevision({ ...job, streamSandbox: makeCronStreamSandboxTarget(change) }),
  ).not.toBe(resolveCronJobConfigRevision(job));
});

it("preserves order when case-insensitive command env keys collide on Windows", () => {
  const firstWinsLast: CronJob = {
    ...makeJob(),
    payload: {
      kind: "command",
      argv: ["printenv"],
      env: { Path: "first", PATH: "second" },
    },
  };
  const secondWinsLast: CronJob = {
    ...firstWinsLast,
    payload: {
      kind: "command",
      argv: ["printenv"],
      env: { PATH: "second", Path: "first" },
    },
  };

  expect(resolveCronJobConfigRevision(firstWinsLast)).not.toBe(
    resolveCronJobConfigRevision(secondWinsLast),
  );
});

it("distinguishes inherited and explicitly cleared delivery fields", () => {
  const inherited = makeJob();
  const explicitlyCleared: CronJob = {
    ...inherited,
    delivery: {
      mode: "announce",
      channel: "telegram",
      to: "chat-1",
      failureDestination: { channel: undefined },
    },
  };

  expect(resolveCronJobConfigRevision(explicitlyCleared)).not.toBe(
    resolveCronJobConfigRevision(inherited),
  );
});

it("matches SQLite normalization across optional fields, schedules, payloads, triggers, and alerts", async () => {
  const { storePath } = await makeStorePath();
  const jobs: CronStoredJob[] = [
    {
      ...makeJob(),
      id: "sandbox-stream",
      schedule: { kind: "stream", command: ["watch-source"] },
      streamSandbox: makeCronStreamSandboxTarget(),
    },
    makeJob({
      agentId: undefined,
      description: undefined,
      payload: { kind: "agentTurn", message, toolsAllow: ["read"], toolsAllowIsDefault: false },
      delivery: {
        mode: "announce",
        failureDestination: { channel: undefined, accountId: undefined },
      },
    }),
    makeJob({
      id: "command-empty-env",
      schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS, anchorMs: 0 },
      payload: { kind: "command", argv: ["true"], env: {}, input: "" },
      failureAlert: false,
    }),
    makeJob({
      id: "default-tools-without-list",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "" },
      payload: { kind: "agentTurn", message, toolsAllowIsDefault: true },
      failureAlert: {},
      trigger: { script: "json({ fire: true })", once: true },
    }),
    makeJob({
      id: "windows-env-key-order",
      payload: { kind: "command", argv: ["printenv"], env: { Path: "first", PATH: "second" } },
    }),
    makeJob({
      id: "default-empty-tools",
      schedule: { kind: "at", at: "2027-01-01T00:00:00.000Z" },
      payload: { kind: "agentTurn", message, toolsAllow: [], toolsAllowIsDefault: true },
    }),
    makeJob({
      id: "on-exit-system-event",
      schedule: { kind: "on-exit", command: "true", cwd: "/tmp" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "Process exited" },
      delivery: undefined,
      failureAlert: { after: 2, cooldownMs: 0, includeSkipped: false },
    }),
  ];
  await saveCronStore(storePath, { version: 1, jobs });
  const sandboxRow = loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath)).find(
    (row) => row.job_id === "sandbox-stream",
  );
  if (!sandboxRow) {
    throw new Error("expected persisted sandbox stream row");
  }
  expect(JSON.parse(sandboxRow.job_json)).toMatchObject({
    schedule: { kind: "sandbox-stream", command: ["watch-source"] },
    streamSandbox: makeCronStreamSandboxTarget(),
  });
  expect(loadedCronStoreFromRows([sandboxRow]).configJobs[0]).toMatchObject({
    schedule: { kind: "sandbox-stream" },
  });
  expect(
    loadedCronStoreFromRows([{ ...sandboxRow, state_json: "invalid" }]).invalidConfigRows[0],
  ).toMatchObject({ reason: "invalid-state", job: { schedule: { kind: "sandbox-stream" } } });
  const reloadedById = new Map((await loadCronStore(storePath)).jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    const reloaded = reloadedById.get(job.id);
    if (!reloaded) {
      throw new Error(`expected persisted cron job ${job.id} to reload`);
    }
    expect(resolveCronJobConfigRevision(reloaded), job.id).toBe(resolveCronJobConfigRevision(job));
  }
});
