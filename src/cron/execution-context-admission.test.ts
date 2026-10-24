import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronStoredJob } from "./types.js";

const readSessionEntryInWorker = vi.fn<(params: { sessionKey: string }) => Promise<unknown>>();
const generationRelease = vi.fn();
const generationAssert = vi.fn();
const prepareSessionGenerationFacts = vi.fn(async (_input: unknown) => ({
  assertCurrent: generationAssert,
  release: generationRelease,
}));

vi.mock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryInWorker: (params: { sessionKey: string }) => readSessionEntryInWorker(params),
}));
vi.mock("../config/sessions/session-delivery-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-delivery-generation.js")>()),
  prepareSessionGenerationFacts: (input: unknown) => prepareSessionGenerationFacts(input),
}));

const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");
const { readScheduledMemoryParent, readScheduledToolTargets } =
  await import("./execution-context-registry.js");
const { buildScheduledParentPauseNotice } = await import("./scheduled-occurrence.js");
const { sessionChanges } = await import("../sessions/session-row-changes.js");

const PARENT_KEY = "agent:main:dashboard:parent";

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
    payload: { kind: "agentTurn", message: "work", toolsAllow: ["*"] },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  } as CronStoredJob;
}

const RUN = {
  cfg: {},
  agentId: "main",
  runId: "run-1",
  runSessionKey: "agent:main:cron:job-1:run:s1",
  toolsAllow: ["*"],
  operatorAuthorityRestored: false,
};

function admit(stored: CronStoredJob) {
  return admitScheduledOccurrence({ cfg: {}, job: stored, agentId: "main", trigger: "cron" });
}

async function mint(stored: CronStoredJob) {
  const occurrence = await admit(stored);
  return { occurrence, minted: occurrence.mint(RUN) };
}

beforeEach(() => {
  readSessionEntryInWorker.mockReset();
  prepareSessionGenerationFacts.mockClear();
  generationRelease.mockReset();
  generationAssert.mockReset();
});

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

const LINKED_JOB = {
  owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
  scheduledToolPolicy: {
    version: 1 as const,
    mode: "account" as const,
    ownerSessionKey: PARENT_KEY,
    ownerAccountId: "default",
  },
  sourceConversation: {
    sessionKey: PARENT_KEY,
    sessionId: "parent-session",
    lifecycleRevision: "rev-1",
  },
};

describe("admitScheduledOccurrence", () => {
  it("rechecks a stored Discord requester's owner status for each occurrence", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const stored = job({
      ...LINKED_JOB,
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        channelRequester: {
          version: 1,
          channel: "discord",
          accountId: "default",
          senderId: "100000000000000001",
        },
      },
    });

    // Reuse the persisted requester, not the creator's historical owner status.
    for (const [senderId, owner] of [
      ["100000000000000001", true],
      ["100000000000000002", false],
    ] as const) {
      const cfg = { commands: { ownerAllowFrom: [`discord:${senderId}`] } };
      const occurrence = await admitScheduledOccurrence({
        cfg,
        job: stored,
        agentId: "main",
        trigger: "cron",
      });
      try {
        expect(occurrence.mint({ ...RUN, cfg }).result).toMatchObject({
          status: "ready",
          facts: {
            authority: { owner, basis: owner ? "channel-owner" : "none" },
            resources: { memory: { source: "parent", owner } },
          },
        });
      } finally {
        occurrence.release();
      }
    }
  });

  it("binds the context to the admitted run and releases it on close", async () => {
    const { minted } = await mint(job({ scheduledToolPolicy: { version: 1, mode: "trusted" } }));
    expect(minted.result.status).toBe("ready");
    const admission = prepareCronRunAdmission({
      cfg: {},
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:cron:job-1:run:s1",
      jobId: "job-1",
      deliveryAttemptFence: null,
      scheduledExecution: minted,
    });
    const operatorRun = await admission.preparedRunAdmission.admit("embedded");
    // An operator job keeps resolving memory from its own run row.
    expect(readScheduledMemoryParent(operatorRun.operationalRunInstance)).toBeUndefined();
    const context = admission.readScheduledExecution();
    expect(context).toMatchObject({
      jobId: "job-1",
      principal: { kind: "operator", basis: "trusted-policy" },
    });
    expect(() => context?.assertCurrent()).not.toThrow();
    admission.close();
    expect(admission.readScheduledExecution()).toBeUndefined();
  });

  it("holds the parent generation for a linked job and releases it", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const { occurrence, minted } = await mint(job(LINKED_JOB));
    expect(minted.result).toMatchObject({ status: "ready", facts: { placement: "child" } });
    expect(prepareSessionGenerationFacts).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: PARENT_KEY, sessionId: "parent-session" }),
    );
    // A run's release ends its context; the occurrence owns the parent generation.
    minted.release();
    expect(generationRelease).not.toHaveBeenCalled();
    occurrence.release();
    expect(generationRelease).toHaveBeenCalledOnce();
  });

  it("holds the observed generation for a revisionless parent link", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const { minted } = await mint(
      job({
        ...LINKED_JOB,
        sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
      }),
    );
    expect(minted.result.status).toBe("ready");
    expect(prepareSessionGenerationFacts).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "parent-session", lifecycleRevision: "rev-1" }),
    );
  });

  it("exposes a child's board, media and memory parent for the run", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const { occurrence, minted } = await mint(job(LINKED_JOB));
    const admission = prepareCronRunAdmission({
      cfg: {},
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:cron:job-1:run:s1",
      jobId: "job-1",
      deliveryAttemptFence: null,
      scheduledExecution: minted,
    });
    const admitted = await admission.preparedRunAdmission.admit("embedded");
    const targets = readScheduledToolTargets(admitted);
    expect(targets).toMatchObject({ boardSessionKey: PARENT_KEY });
    expect(() => targets?.assertCurrent()).not.toThrow();
    generationAssert.mockImplementationOnce(() => {
      throw new Error("parent reset");
    });
    expect(() => targets?.assertCurrent()).toThrow("parent reset");
    // No requester check ran for this occurrence, so the parent's audience is not owner-private.
    expect(readScheduledMemoryParent(admitted.operationalRunInstance)).toEqual({
      sessionKey: PARENT_KEY,
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      senderIsOwner: false,
    });
    admission.close();
    expect(readScheduledToolTargets(admitted)).toBeUndefined();
    expect(readScheduledMemoryParent(admitted.operationalRunInstance)).toBeUndefined();
    // Tools built during the run keep the assertion; it must refuse after the run settles.
    expect(() => targets?.assertCurrent()).toThrow("settled");
    occurrence.release();
  });

  it("reports a removed parent as a pause without throwing", async () => {
    readSessionEntryInWorker.mockResolvedValue(undefined);
    const { minted } = await mint(
      job({ sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } }),
    );
    expect(minted.result).toEqual({
      status: "pause",
      reason: "removed",
      parentSessionKey: PARENT_KEY,
    });
    expect(prepareSessionGenerationFacts).not.toHaveBeenCalled();
  });

  it("turns a failed parent read into a fail result", async () => {
    readSessionEntryInWorker.mockRejectedValue(new Error("worker unavailable"));
    const { occurrence, minted } = await mint(
      job({ sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } }),
    );
    expect(minted.result).toEqual({ status: "fail", error: "worker unavailable" });
    expect(() => minted.release()).not.toThrow();
    expect(() => occurrence.release()).not.toThrow();
  });

  it("reads the parent once for every run the occurrence admits", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const occurrence = await admit(job(LINKED_JOB));
    const first = occurrence.mint(RUN);
    const retry = occurrence.mint({ ...RUN, runId: "run-2" });
    expect(readSessionEntryInWorker).toHaveBeenCalledOnce();
    expect(prepareSessionGenerationFacts).toHaveBeenCalledOnce();
    expect(first.result).toMatchObject({
      status: "ready",
      facts: { occurrence: { runId: "run-1" } },
    });
    expect(retry.result).toMatchObject({
      status: "ready",
      facts: { occurrence: { runId: "run-2" } },
    });
    occurrence.release();
  });

  it("checks a restored operator source per run", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const occurrence = await admit(
      job({ sessionTarget: `session:${PARENT_KEY}`, operatorSource: operatorSource() }),
    );
    const runSessionKey = PARENT_KEY;
    expect(occurrence.mint({ ...RUN, runSessionKey }).result).toMatchObject({
      status: "ready",
      facts: { authority: { owner: false, basis: "none" } },
    });
    expect(
      occurrence.mint({ ...RUN, runSessionKey, operatorAuthorityRestored: true }).result,
    ).toMatchObject({
      status: "ready",
      facts: { authority: { owner: true, basis: "operator-source" } },
    });
    occurrence.release();
  });

  it("gives main-session jobs an in-session context on the main session", async () => {
    const { minted } = await mint(
      job({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "check in" },
        owner: { agentId: "main", sessionKey: "agent:main:main" },
      }),
    );
    expect(readSessionEntryInWorker).not.toHaveBeenCalled();
    expect(minted.result).toMatchObject({
      status: "ready",
      facts: { placement: "in-session", principal: { kind: "unbound-parent" } },
    });
  });
});

describe("occurrence pause", () => {
  const linked = job({
    name: "Nightly ingest",
    sourceConversation: {
      sessionKey: PARENT_KEY,
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    },
  });

  it("does not read anything for jobs without an exact parent link", async () => {
    expect((await admit(job())).pause).toBeUndefined();
    expect(readSessionEntryInWorker).not.toHaveBeenCalled();
  });

  it.each([
    ["removed", undefined],
    ["archived", { sessionId: "parent-session", lifecycleRevision: "rev-1", archivedAt: 1 }],
  ] as const)("pauses when the parent is %s", async (reason, entry) => {
    readSessionEntryInWorker.mockResolvedValue(entry);
    const occurrence = await admit(linked);
    expect(occurrence.pause).toEqual({ reason, parentSessionKey: PARENT_KEY });
    expect(prepareSessionGenerationFacts).not.toHaveBeenCalled();
  });

  it("pauses when the parent's bound worktree is gone", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      worktree: true,
      spawnedCwd: "/nonexistent/openclaw-test-worktree",
    });
    const occurrence = await admit(linked);
    expect(occurrence.pause).toEqual({
      reason: "worktree-missing",
      parentSessionKey: PARENT_KEY,
      worktreePath: "/nonexistent/openclaw-test-worktree",
    });
    occurrence.release();
  });

  it("keeps running when the parent was reset", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "new-session",
      lifecycleRevision: "rev-2",
    });
    const occurrence = await admit(linked);
    expect(occurrence.pause).toBeUndefined();
    expect(occurrence.mint(RUN).result).toMatchObject({
      status: "ready",
      facts: { principal: { kind: "unbound-parent", parentSessionKey: PARENT_KEY } },
    });
  });

  it("ignores the replacement session's worktree after a reset", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "new-session",
      lifecycleRevision: "rev-2",
      worktree: true,
      spawnedCwd: "/nonexistent/openclaw-test-worktree",
    });
    const occurrence = await admit(linked);
    expect(occurrence.pause).toBeUndefined();
    expect(occurrence.mint(RUN).result).toMatchObject({
      status: "ready",
      facts: { principal: { kind: "unbound-parent", parentSessionKey: PARENT_KEY } },
    });
  });

  it("runs when the parent is current", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const occurrence = await admit(linked);
    expect(occurrence.pause).toBeUndefined();
    occurrence.release();
  });

  it("hands a child run its current parent's bound row, sandbox requirement and live check", async () => {
    const parentEntry = {
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      sandbox: "required" as const,
      spawnedCwd: "/work/project",
    };
    readSessionEntryInWorker.mockResolvedValue(parentEntry);
    const occurrence = await admit(linked);
    expect(occurrence.childParent).toEqual({
      binding: { sessionKey: PARENT_KEY, entry: parentEntry },
      sandbox: "required",
      assertCurrent: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(() => occurrence.childParent?.assertCurrent()).not.toThrow();
    generationAssert.mockImplementationOnce(() => {
      throw new Error("parent reset");
    });
    expect(() => occurrence.childParent?.assertCurrent()).toThrow("parent reset");
    occurrence.release();
    expect(() => occurrence.childParent?.assertCurrent()).toThrow("settled");
  });

  it("aborts a bound child's signal once a parent row change ends the parent", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      spawnedCwd: "/work/project",
    });
    const occurrence = await admit(linked);
    const signal = occurrence.childParent?.signal;
    const reset = new Error("parent reset");
    generationAssert.mockImplementation(() => {
      throw reset;
    });
    sessionChanges.invalidate({ sessionKey: "agent:main:dashboard:other", storePath: "/s" });
    expect(signal?.aborted).toBe(false);
    sessionChanges.invalidate({ sessionKey: PARENT_KEY, storePath: "/s" });
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(reset);
    occurrence.release();
  });

  it("keeps a bound child's signal live while the parent stays current and after settlement", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      spawnedCwd: "/work/project",
    });
    const occurrence = await admit(linked);
    const signal = occurrence.childParent?.signal;
    sessionChanges.invalidate({ sessionKey: PARENT_KEY, storePath: "/s" });
    expect(signal?.aborted).toBe(false);
    occurrence.release();
    generationAssert.mockImplementation(() => {
      throw new Error("parent reset");
    });
    sessionChanges.invalidate({ sessionKey: PARENT_KEY, storePath: "/s" });
    expect(signal?.aborted).toBe(false);
  });

  it("hands an unbound parent's child only its sandbox requirement", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
      sandbox: "required",
    });
    const occurrence = await admit(linked);
    expect(occurrence.childParent).toEqual({
      sandbox: "required",
      assertCurrent: expect.any(Function),
    });
    occurrence.release();
  });

  it("leaves an in-session job's own binding to the session it runs in", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const occurrence = await admit({ ...linked, sessionTarget: `session:${PARENT_KEY}` });
    expect(occurrence.childParent).toBeUndefined();
    occurrence.release();
  });

  it("hands no binding to a reset parent's unbound run", async () => {
    readSessionEntryInWorker.mockResolvedValue({ sessionId: "new-session" });
    expect((await admit(linked)).childParent).toBeUndefined();
  });

  it("never pauses on a failed read", async () => {
    readSessionEntryInWorker.mockRejectedValue(new Error("worker unavailable"));
    expect((await admit(linked)).pause).toBeUndefined();
  });

  it("names the parent and the repair in the notice", () => {
    const text = buildScheduledParentPauseNotice({
      job: { id: "job-1", name: "Nightly ingest" },
      pause: { reason: "archived", parentSessionKey: PARENT_KEY },
    });
    expect(text).toContain(`\`${PARENT_KEY}\``);
    expect(text).toContain("it was archived");
    expect(text).toContain("openclaw automations enable job-1");
  });
});

describe("prepareCronRunAdmission", () => {
  it("refuses a scheduled run that carries no admitted occurrence", () => {
    expect(() =>
      prepareCronRunAdmission({
        cfg: {},
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:cron:job-1:run:s1",
        jobId: "job-1",
        deliveryAttemptFence: null,
      } as unknown as Parameters<typeof prepareCronRunAdmission>[0]),
    ).toThrow("a scheduled run requires its admitted occurrence");
  });
});
