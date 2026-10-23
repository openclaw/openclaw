import { describe, expect, it } from "vitest";
import {
  buildScheduledExecutionContext,
  resolveScheduledRequester,
  type ScheduledAdmissionFacts,
  type ScheduledExecutionFacts,
} from "./execution-context.js";
import type { CronStoredJob } from "./types.js";

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:run-session";
const MAIN_KEY = "agent:main:main";
const ACCOUNT_POLICY = {
  version: 1,
  mode: "account",
  ownerSessionKey: PARENT_KEY,
  ownerAccountId: "default",
} as const;
const PROFILE_ACTOR = { type: "human", source: "profile", id: "profile-1" } as const;
const SOURCE = { sessionKey: PARENT_KEY, sessionId: "parent-session", lifecycleRevision: "rev-1" };

function job(overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do work", toolsAllow: ["*"] },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  } as CronStoredJob;
}

function parentLinked(overrides: Partial<CronStoredJob> = {}) {
  return job({
    owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
    scheduledToolPolicy: ACCOUNT_POLICY,
    sourceConversation: SOURCE,
    createdActor: PROFILE_ACTOR,
    ...overrides,
  });
}

function facts(overrides: Partial<ScheduledAdmissionFacts> = {}): ScheduledAdmissionFacts {
  return {
    trigger: "cron",
    occurrence: { runId: "run-1", executionRevision: "exec-1" },
    agentId: "main",
    runSessionKey: RUN_KEY,
    agentMainSessionKey: MAIN_KEY,
    agentSandboxMode: "off",
    parentRow: {
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      archived: false,
      sandboxRequired: false,
      workspaceDir: "/work/parent",
    },
    requesterCheck: { owner: true },
    ...overrides,
  };
}

function ready(j: CronStoredJob, f: ScheduledAdmissionFacts): ScheduledExecutionFacts {
  const result = buildScheduledExecutionContext(j, f);
  if (result.status !== "ready") {
    throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  }
  return result.facts;
}

function operatorSource() {
  return {
    executionRevision: "exec-1",
    source: {
      version: 1,
      agentId: "main",
      sessionKey: PARENT_KEY,
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      sourceRunId: "source-run",
      snapshot: {
        profileId: "profile-1",
        scopes: ["operator.admin"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "grant-gen",
          role: "operator",
          authMethod: "device-token",
        },
        device: { deviceId: "device-1", key: "a".repeat(64) },
        controlUiAdmin: true,
        localOperator: false,
        sourceIngress: "control-ui",
      },
    },
  } as unknown as NonNullable<CronStoredJob["operatorSource"]>;
}

describe("buildScheduledExecutionContext principals", () => {
  it("makes an exactly linked isolated job a child of its creating conversation", () => {
    const context = ready(parentLinked(), facts());
    expect(context.principal).toEqual({
      kind: "parent",
      parent: { agentId: "main", ...SOURCE },
      requester: { kind: "profile", profileId: "profile-1" },
    });
    expect(context.placement).toBe("child");
    expect(context.authority).toEqual({
      owner: true,
      basis: "profile-role",
      admissionSource: "requester-schedule",
    });
    expect(context.toolPolicy.automations).toEqual({
      scope: "self-and-parent-wake",
      jobId: "job-1",
      parentSessionKey: PARENT_KEY,
    });
    expect(context.resources).toMatchObject({
      memory: { source: "parent", owner: true },
      boardSessionKey: PARENT_KEY,
      mediaSessionKey: PARENT_KEY,
      eventTargetSessionKey: PARENT_KEY,
      workspace: { source: "parent-row", dir: "/work/parent" },
      fileScope: "session",
      bootstrap: "default",
      messageAccounts: { ownerAccountId: "default" },
      delivery: { sourceConversation: SOURCE },
    });
  });

  it("gives a parent-linked job without a recorded requester no owner authority", () => {
    const context = ready(parentLinked({ createdActor: undefined }), facts());
    expect(resolveScheduledRequester(parentLinked({ createdActor: undefined }))).toEqual({
      kind: "unknown",
    });
    // A passing check for some other identity never lends owner status.
    expect(context.authority).toMatchObject({ owner: false, basis: "none" });
    expect(context.toolPolicy.automations).toEqual({ scope: "self", jobId: "job-1" });
    expect(context.resources.memory).toMatchObject({ source: "parent", owner: false });
  });

  it("fails closed when the caller did not run the requester check", () => {
    const context = ready(parentLinked(), facts({ requesterCheck: undefined }));
    expect(context.authority).toMatchObject({ owner: false, basis: "none" });
  });

  it("treats a requester who no longer passes as non-owner", () => {
    const context = ready(parentLinked(), facts({ requesterCheck: { owner: false } }));
    expect(context.authority).toMatchObject({ owner: false, basis: "none" });
  });

  it("prefers the operator source and names its exact incarnation", () => {
    const stored = parentLinked({
      sessionTarget: `session:${PARENT_KEY}`,
      operatorSource: operatorSource(),
    });
    const context = ready(stored, facts({ runSessionKey: PARENT_KEY }));
    expect(context.principal).toMatchObject({
      kind: "parent",
      parent: { sessionKey: PARENT_KEY, sessionId: "parent-session", lifecycleRevision: "rev-1" },
      requester: { kind: "operator-source" },
    });
    expect(context.placement).toBe("in-session");
    expect(context.authority.basis).toBe("operator-source");
  });

  it("fails an occurrence whose stored operator source does not decode", () => {
    const stored = parentLinked({
      operatorSource: { executionRevision: "x", source: { version: 2 } } as never,
    });
    expect(buildScheduledExecutionContext(stored, facts())).toEqual({
      status: "fail",
      error: "stored operator source is invalid",
    });
  });

  it("keeps account-mode jobs without an incarnation on their legacy decisions", () => {
    const stored = job({
      owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
      scheduledToolPolicy: ACCOUNT_POLICY,
      createdActor: PROFILE_ACTOR,
    });
    const context = ready(stored, facts({ parentRow: undefined, requesterCheck: undefined }));
    expect(context.principal).toEqual({ kind: "unbound-parent", parentSessionKey: PARENT_KEY });
    expect(context.placement).toBe("detached");
    expect(context.authority).toEqual({
      owner: true,
      basis: "legacy",
      admissionSource: "requester-schedule",
    });
    expect(context.toolPolicy.automations).toEqual({ scope: "self", jobId: "job-1" });
    expect(context.resources).toMatchObject({
      memory: { source: "run-session" },
      boardSessionKey: RUN_KEY,
      eventTargetSessionKey: MAIN_KEY,
      workspace: { source: "run-session" },
      fileScope: "root",
      bootstrap: "cron-allowlist",
    });
  });

  it("keeps trusted-policy jobs with an owner key requester-scoped", () => {
    // owner.sessionKey makes the legacy rule requester-schedule; a trusted
    // policy must not promote the job to operator-schedule.
    const stored = job({
      sessionTarget: `session:${PARENT_KEY}`,
      owner: { agentId: "main", sessionKey: PARENT_KEY },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    const context = ready(stored, facts({ runSessionKey: PARENT_KEY, parentRow: undefined }));
    expect(context.principal).toEqual({ kind: "operator", basis: "trusted-policy" });
    expect(context.placement).toBe("in-session");
    expect(context.authority.admissionSource).toBe("requester-schedule");
  });

  it("treats a trusted isolated job without owner fields as an operator job", () => {
    const stored = job({ scheduledToolPolicy: { version: 1, mode: "trusted" } });
    const context = ready(stored, facts({ parentRow: undefined }));
    expect(context.principal).toEqual({ kind: "operator", basis: "trusted-policy" });
    expect(context.authority.admissionSource).toBe("operator-schedule");
    expect(context.placement).toBe("detached");
  });

  it("runs an unlinked session job in its session with operator authority", () => {
    const stored = job({ sessionTarget: "session:agent:main:dashboard:other" });
    const context = ready(
      stored,
      facts({ runSessionKey: "agent:main:dashboard:other", parentRow: undefined }),
    );
    expect(context.principal).toEqual({ kind: "operator", basis: "unlinked-legacy" });
    expect(context.placement).toBe("in-session");
    expect(context.resources).toMatchObject({
      boardSessionKey: "agent:main:dashboard:other",
      eventTargetSessionKey: "agent:main:dashboard:other",
      fileScope: "session",
      bootstrap: "default",
    });
  });

  it("gives hook turns an ingress principal with self-scoped automations", () => {
    const hook = job({
      payload: { kind: "agentTurn", message: "hook", externalContentSource: "webhook" },
    });
    const context = ready(
      hook,
      facts({ trigger: "event", ingress: "webhook", parentRow: undefined }),
    );
    expect(context.principal).toEqual({ kind: "ingress", ingress: "webhook" });
    expect(context.authority).toEqual({ owner: false, basis: "none" });
    expect(context.toolPolicy.automations).toEqual({ scope: "self", jobId: "job-1" });
  });

  it("requires event-triggered runs to name their ingress", () => {
    expect(buildScheduledExecutionContext(job(), facts({ trigger: "event" }))).toEqual({
      status: "fail",
      error: "event-triggered runs must name their ingress",
    });
  });

  it("runs main-session jobs in the main session, like session:<key>", () => {
    const context = ready(
      job({ sessionTarget: "main" }),
      facts({ runSessionKey: MAIN_KEY, agentSandboxMode: "non-main" }),
    );
    expect(context.placement).toBe("in-session");
    expect(context.resources).toMatchObject({
      boardSessionKey: MAIN_KEY,
      eventTargetSessionKey: MAIN_KEY,
      fileScope: "session",
      bootstrap: "default",
      sandbox: { required: false, basis: [] },
    });
  });
});

describe("buildScheduledExecutionContext parent lifecycle", () => {
  const live = {
    sessionId: "parent-session",
    lifecycleRevision: "rev-1",
    archived: false,
    sandboxRequired: false,
  };

  it.each([
    ["removed", { missing: true } as const],
    ["archived", { ...live, archived: true }],
  ] as const)("pauses when the parent is %s", (reason, parentRow) => {
    expect(buildScheduledExecutionContext(parentLinked(), facts({ parentRow }))).toEqual({
      status: "pause",
      reason,
      parentSessionKey: PARENT_KEY,
    });
  });

  it.each([
    ["session id", { ...live, sessionId: "new-session", sandboxRequired: true }],
    ["lifecycle revision", { ...live, lifecycleRevision: "rev-2", sandboxRequired: true }],
  ] as const)("runs unbound with legacy decisions when the parent's %s changed", (_, parentRow) => {
    const result = buildScheduledExecutionContext(parentLinked(), facts({ parentRow }));
    if (result.status !== "ready") {
      throw new Error(`expected ready, got ${result.status}`);
    }
    const context = result.facts;
    expect(context.principal).toEqual({ kind: "unbound-parent", parentSessionKey: PARENT_KEY });
    expect(context.authority.basis).toBe("legacy");
    expect(context.resources.memory).toEqual({ source: "run-session" });
    expect(context.resources.boardSessionKey).toBe(context.resources.mediaSessionKey);
    expect(context.resources.boardSessionKey).not.toBe(PARENT_KEY);
    expect(context.resources.workspace).toEqual({ source: "run-session" });
    expect(context.resources.sandbox.basis).not.toContain("parent-row");
    expect(context.toolPolicy.automations).not.toMatchObject({ scope: "self-and-parent-wake" });
  });

  it("pauses when the parent's bound worktree is gone", () => {
    const parentRow = { ...live, worktree: { path: "/work/tree", exists: false } };
    expect(buildScheduledExecutionContext(parentLinked(), facts({ parentRow }))).toEqual({
      status: "pause",
      reason: "worktree-missing",
      parentSessionKey: PARENT_KEY,
      worktreePath: "/work/tree",
    });
  });

  it("checks only the session id when the link stored no lifecycle revision", () => {
    const stored = parentLinked({
      sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
    });
    const result = buildScheduledExecutionContext(
      stored,
      facts({ parentRow: { ...live, lifecycleRevision: "any" } }),
    );
    expect(result.status).toBe("ready");
  });

  it("fails when the caller did not read the parent row", () => {
    expect(buildScheduledExecutionContext(parentLinked(), facts({ parentRow: undefined }))).toEqual(
      {
        status: "fail",
        error: "parent session facts are required for a parent-linked job",
      },
    );
  });
});

describe("buildScheduledExecutionContext scopes", () => {
  it.each([
    [[], { scope: "none" }],
    [["read"], { scope: "none" }],
    [["*"], { scope: "self", jobId: "job-1" }],
    [["automations"], { scope: "self", jobId: "job-1" }],
  ] as const)("derives automations scope from toolsAllow %j", (toolsAllow, scope) => {
    const stored = job({
      payload: { kind: "agentTurn", message: "x", toolsAllow: [...toolsAllow] },
    });
    expect(ready(stored, facts({ parentRow: undefined })).toolPolicy.automations).toEqual(scope);
  });

  it("requires a sandbox when any source requires one", () => {
    const sandbox = (overrides: Partial<ScheduledAdmissionFacts>, stored = parentLinked()) =>
      ready(stored, facts(overrides)).resources.sandbox;
    expect(sandbox({})).toEqual({ required: false, basis: [] });
    expect(sandbox({ agentSandboxMode: "non-main" })).toEqual({
      required: true,
      basis: ["agent-config"],
    });
    expect(sandbox({ agentSandboxMode: "non-main", runSessionKey: MAIN_KEY }).required).toBe(false);
    expect(sandbox({ creatorRoleSandbox: "required" }).basis).toEqual(["creator-role"]);
    expect(
      sandbox({
        parentRow: {
          sessionId: "parent-session",
          lifecycleRevision: "rev-1",
          archived: false,
          sandboxRequired: true,
        },
      }).basis,
    ).toEqual(["parent-row"]);
  });

  it("records the inference account the job stored", () => {
    const binding = {
      version: 1,
      provider: "openai",
      profileId: "openai:p",
      authorizationId: "auth",
      authRequirement: "api-key",
      source: "auto",
    } as const;
    expect(ready(parentLinked({ inferenceBinding: binding }), facts()).inference).toEqual({
      kind: "bound",
      binding,
    });
    expect(
      ready(parentLinked({ runtimeAuthorityRecoveryRequired: true }), facts()).inference,
    ).toEqual({ kind: "runtime-recovery-required" });
    expect(ready(parentLinked(), facts()).inference).toEqual({ kind: "none" });
  });
});
