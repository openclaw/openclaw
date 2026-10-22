import { describe, expect, it } from "vitest";
import { anonymize, anonymizeParentRow } from "../../scripts/dev/cron-context-replay.mts";
import { replayScheduledContextFixture } from "../../src/cron/execution-context.fixtures.test-support.js";
import { resolveScheduledRequester } from "../../src/cron/execution-context.js";
import type { CronStoredJob } from "../../src/cron/types.js";

const parentKey = "agent:ops:dashboard:private-parent";

function storedJob(overrides: Partial<CronStoredJob>): CronStoredJob {
  return {
    id: "private-job",
    agentId: "ops",
    name: "private name",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "private prompt" },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  } as CronStoredJob;
}

const operatorSource = {
  executionRevision: "private-revision",
  source: {
    version: 1,
    agentId: "ops",
    sessionKey: parentKey,
    sessionId: "private-session",
    lifecycleRevision: "private-rev",
    sourceRunId: "private-run",
    snapshot: {
      profileId: "private-profile",
      scopes: ["operator.admin"],
      assignedRole: null,
      githubLogin: "private-login",
      grant: null,
      aliasBindingIds: [],
      authPolicy: {
        generation: "",
        grantGeneration: "private-generation",
        role: "operator",
        authMethod: "token",
      },
      controlUiAdmin: true,
      localOperator: false,
      sourceIngress: "control-ui",
    },
  },
} as unknown as NonNullable<CronStoredJob["operatorSource"]>;

const liveRow = {
  sessionId: "private-session",
  lifecycleRevision: "private-rev",
  archived: false,
  sandboxRequired: false,
};

describe("cron context replay fixtures", () => {
  it("keeps an operator-source parent as the fixture's principal", () => {
    const job = storedJob({ operatorSource });
    const fixture = { job: anonymize(job, "ops", 1), parentRow: anonymizeParentRow(liveRow, job) };

    expect(resolveScheduledRequester(fixture.job).kind).toBe("operator-source");
    expect(JSON.stringify(fixture)).not.toMatch(/private/);
    expect(replayScheduledContextFixture(fixture)).toMatchObject({
      status: "ready",
      principal: "parent",
    });
  });

  it("keeps a channel requester", () => {
    const job = storedJob({
      sourceConversation: { sessionKey: parentKey, sessionId: "private-session" },
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        channelRequester: {
          version: 1,
          channel: "telegram",
          accountId: "private-account",
          senderId: "private-sender",
        },
      },
    } as Partial<CronStoredJob>);

    const requester = resolveScheduledRequester(anonymize(job, "ops", 1));

    expect(requester).toEqual({
      kind: "channel",
      requester: { version: 1, channel: "telegram", accountId: "default", senderId: "sender-1" },
    });
  });

  it("keeps a changed lifecycle revision as a reset", () => {
    const job = storedJob({ operatorSource });
    const row = { ...liveRow, lifecycleRevision: "private-rev-2" };
    const fixture = { job: anonymize(job, "ops", 1), parentRow: anonymizeParentRow(row, job) };

    expect(fixture.parentRow).toMatchObject({
      sessionId: "parent-session",
      lifecycleRevision: "rev-2",
    });
    expect(replayScheduledContextFixture(fixture).status).toBe("pause");
  });

  it("keeps a missing worktree", () => {
    const job = storedJob({ operatorSource });
    const row = {
      ...liveRow,
      cwd: "/private/worktree",
      worktree: { path: "/private/worktree", exists: false },
    };
    const fixture = { job: anonymize(job, "ops", 1), parentRow: anonymizeParentRow(row, job) };

    expect(fixture.parentRow).toMatchObject({
      cwd: "/work/parent/worktree",
      worktree: { path: "/work/parent/worktree", exists: false },
    });
    expect(replayScheduledContextFixture(fixture).status).toBe("pause");
  });
});
