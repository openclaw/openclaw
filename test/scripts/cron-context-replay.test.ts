import { describe, expect, it, vi } from "vitest";
import {
  anonymize,
  anonymizeParentRow,
  replayInferenceRuntimes,
} from "../../scripts/dev/cron-context-replay.mts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { replayScheduledContextFixture } from "../../src/cron/execution-context.fixtures.test-support.js";
import { resolveScheduledRequester } from "../../src/cron/execution-context.js";
import { resolveCronRunToolsAllow } from "../../src/cron/tools-allow.js";
import type { CronStoredJob } from "../../src/cron/types.js";

vi.mock("../../src/cron/isolated-agent/model-selection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cron/isolated-agent/model-selection.js")>();
  // The published catalog owner needs a running Gateway; selection itself stays real.
  return {
    ...actual,
    resolveCronModelSelectionOwner: async (params: { cfg: OpenClawConfig; agentId: string }) => ({
      agentId: params.agentId,
      agentDir: "/work/agent",
      workspaceDir: "/work/workspace",
      config: params.cfg,
      metadataSnapshot: undefined,
      modelCatalog: { entries: [] },
    }),
  };
});

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

function parentFixture(row: Parameters<typeof anonymizeParentRow>[0] = liveRow) {
  const job = storedJob({ operatorSource });
  return { job: anonymize(job, "ops", 1), parentRow: anonymizeParentRow(row, job) };
}

describe("cron context replay fixtures", () => {
  it("keeps an operator-source parent as the fixture's principal", () => {
    const fixture = parentFixture();

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
    const fixture = parentFixture({ ...liveRow, lifecycleRevision: "private-rev-2" });

    expect(fixture.parentRow).toMatchObject({
      sessionId: "parent-session",
      lifecycleRevision: "rev-2",
    });
    expect(replayScheduledContextFixture(fixture)).toMatchObject({
      status: "ready",
      principal: "unbound-parent",
    });
  });

  it("replaces script and system event bodies but keeps their tool caps", () => {
    const toolsAllow = ["write", "edit", "exec", "process", "web_search", "message"];
    for (const payload of [
      { kind: "script", script: "return 'private script'", toolsAllow },
      { kind: "systemEvent", text: "private text", toolsAllow },
    ] as const) {
      const job = storedJob({ payload });
      const fixture = anonymize(job, "ops", 1);
      expect(JSON.stringify(fixture)).not.toMatch(/private/);
      expect(fixture.payload.kind).toBe(job.payload.kind);
      expect(resolveCronRunToolsAllow(fixture)).toEqual(toolsAllow);
    }
  });

  it.each([
    { trigger: { script: "return 'private condition'" } },
    {
      runtimeAuthority: {
        version: 1,
        runtimeId: "codex",
        namespace: "app",
        payload: { secret: "private" },
      },
    },
    { runtimeAuthorityRecoveryRequired: true },
  ] as Partial<CronStoredJob>[])("keeps a restricted automatic tool cap for %j", (fields) => {
    const job = storedJob({
      owner: { agentId: "ops", sessionKey: parentKey, accountId: "private-account" },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: parentKey,
        ownerAccountId: "private-account",
      },
      payload: {
        kind: "agentTurn",
        message: "private prompt",
        toolsAllow: ["read"],
        toolsAllowIsDefault: true,
      },
      ...fields,
    } as Partial<CronStoredJob>);
    const fixture = anonymize(job, "ops", 1);

    expect(resolveCronRunToolsAllow(fixture)).toEqual(["read"]);
    expect(JSON.stringify(fixture)).not.toMatch(/private/);
  });

  it("keeps a missing worktree", () => {
    const fixture = parentFixture({
      ...liveRow,
      cwd: "/private/worktree",
      worktree: { path: "/private/worktree", exists: false },
    });

    expect(fixture.parentRow).toMatchObject({
      cwd: "/work/parent/worktree",
      worktree: { path: "/work/parent/worktree", exists: false },
    });
    expect(replayScheduledContextFixture(fixture).status).toBe("pause");
  });
});

describe("replayInferenceRuntimes", () => {
  it("selects the scheduled model the run selects, not the global primary", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "anthropic/claude-haiku-4-5",
          subagents: { model: "anthropic/claude-sonnet-4-5" },
          models: { "anthropic/claude-sonnet-4-5": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    };
    const job = storedJob({
      agentId: "main",
      inferenceBinding: {
        provider: "anthropic",
        profileId: "anthropic:profile",
        authorizationId: "authorization",
        runtime: "claude-cli",
      },
    } as Partial<CronStoredJob>);
    await expect(replayInferenceRuntimes(job, "main", cfg, () => undefined)).resolves.toEqual({
      runtimes: { legacy: "claude-cli" },
    });
  });

  it("reports an unresolved comparison when selection leaves the bound provider", async () => {
    const cfg: OpenClawConfig = { agents: { defaults: { model: "openai/gpt-5" } } };
    const job = storedJob({
      agentId: "main",
      inferenceBinding: {
        provider: "anthropic",
        profileId: "anthropic:profile",
        authorizationId: "authorization",
      },
    } as Partial<CronStoredJob>);
    await expect(replayInferenceRuntimes(job, "main", cfg, () => undefined)).resolves.toEqual({
      unresolved: "selected provider openai is not bound provider anthropic",
    });
  });
});
