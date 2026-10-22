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

const { mintCronPromptExecutionContext } = await import("./execution-context-admission.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

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

function mint(stored: CronStoredJob) {
  return mintCronPromptExecutionContext(
    {
      cfgWithAgentDefaults: {},
      job: stored,
      agentId: "main",
      runSessionKey: "agent:main:cron:job-1:run:s1",
      cronSession: { storePath: "/tmp/store.json" },
      agentPayload: { toolsAllow: ["*"] },
    },
    { runId: "run-1", trigger: "cron" },
  );
}

beforeEach(() => {
  readSessionEntryInWorker.mockReset();
  prepareSessionGenerationFacts.mockClear();
  generationRelease.mockReset();
  generationAssert.mockReset();
});

describe("mintCronPromptExecutionContext", () => {
  it("binds the context to the admitted run and releases it on close", async () => {
    const minted = await mint(job({ scheduledToolPolicy: { version: 1, mode: "trusted" } }));
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
    await admission.preparedRunAdmission.admit("embedded");
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
    const minted = await mint(
      job({
        owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: PARENT_KEY,
          ownerAccountId: "default",
        },
        sourceConversation: {
          sessionKey: PARENT_KEY,
          sessionId: "parent-session",
          lifecycleRevision: "rev-1",
        },
      }),
    );
    expect(minted.result).toMatchObject({ status: "ready", facts: { placement: "child" } });
    expect(prepareSessionGenerationFacts).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: PARENT_KEY, sessionId: "parent-session" }),
    );
    minted.release();
    expect(generationRelease).toHaveBeenCalledOnce();
  });

  it("holds the observed generation for a revisionless parent link", async () => {
    readSessionEntryInWorker.mockResolvedValue({
      sessionId: "parent-session",
      lifecycleRevision: "rev-1",
    });
    const minted = await mint(
      job({
        owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: PARENT_KEY,
          ownerAccountId: "default",
        },
        sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
      }),
    );
    expect(minted.result.status).toBe("ready");
    expect(prepareSessionGenerationFacts).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "parent-session", lifecycleRevision: "rev-1" }),
    );
  });

  it("reports a removed parent as a pause without throwing", async () => {
    readSessionEntryInWorker.mockResolvedValue(undefined);
    const minted = await mint(
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
    const minted = await mint(
      job({ sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" } }),
    );
    expect(minted.result).toEqual({ status: "fail", error: "worker unavailable" });
    expect(() => minted.release()).not.toThrow();
  });
});
