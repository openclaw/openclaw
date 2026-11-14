import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { MemoryAudience, MemoryProviderHandle } from "../plugins/memory-provider-types.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import type { CronStoredJob } from "./types.js";

// mock-isolation: the fake session owner replaces SQLite generation facts.
vi.mock("../config/sessions/session-delivery-generation.js", async () => {
  const { fakeSessionGenerationModule } =
    await import("../plugins/memory-audience.test-support.js");
  return fakeSessionGenerationModule;
});
vi.mock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => {
  const { fakeSessionEntryReadModule, fakeSessionOwner } =
    await import("../plugins/memory-audience.test-support.js");
  return {
    ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
    ...fakeSessionEntryReadModule,
    readSessionEntryInWorker: async ({ sessionKey }: { sessionKey: string }) =>
      fakeSessionOwner.rows.get(sessionKey),
  };
});
// mock-isolation: a native provider is loaded without activating a real plugin.
vi.mock("../plugins/memory-state.js", () => ({ resolveLoadedMemoryProviderKind: () => "native" }));
// The requester's profile access is the owner check this occurrence runs.
const profiles = vi.hoisted(() => ({ revoked: new Set<string>() }));
vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: (profileId: string) => ({
    assertCurrent: () => {
      if (profiles.revoked.has(profileId)) {
        throw new Error("profile revoked");
      }
    },
  }),
}));

const { fakeSessionOwner } = await import("../plugins/memory-audience.test-support.js");
const { bindMemoryProvider } = await import("../plugins/memory-provider-adapter.js");
const { resolveEmbeddedAttemptMemoryAudience } =
  await import("../agents/embedded-agent-runner/run/attempt-memory-audience.js");
const { resolveCliMcpMemoryAudience } = await import("../agents/cli-runner/mcp-memory-audience.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const STORE_PATH = "/tmp/openclaw-scheduled-memory/main.sqlite";
const OWNER_PROFILE = "owner-profile";
const PARENT_SESSION = randomUUID();
const RUN_SESSION = randomUUID();

beforeEach(() => {
  fakeSessionOwner.reset();
  profiles.revoked.clear();
});

function storedJob(overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    ...cronTestJob({ id: "job-1", name: "Knowledge ingest", wakeMode: "now" }),
    agentId: "main",
    delivery: { mode: "none" },
    owner: { agentId: "main", sessionKey: PARENT_KEY, accountId: "default" },
    sourceConversation: {
      sessionKey: PARENT_KEY,
      sessionId: PARENT_SESSION,
      lifecycleRevision: "rev-1",
    },
    createdActor: { type: "human", source: "profile", id: OWNER_PROFILE },
    ...overrides,
  };
}

function provider(): MemoryProviderHandle & { health: ReturnType<typeof vi.fn> } {
  return {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
    search: vi.fn(async () => ({ hits: [] })),
    get: vi.fn(async () => ({ status: "not_found" as const })),
    health: vi.fn(async () => ({ status: "ready" as const })),
    close: vi.fn(async () => {}),
  };
}

// Binds a provider to the run's audience the way the host hands it to memory tools.
function bindToRun(raw: MemoryProviderHandle, audience: MemoryAudience) {
  return bindMemoryProvider(raw, "test", {
    authority: { kind: "session", sessionKey: RUN_KEY, sandboxed: false, audience },
    assertCurrent() {},
  });
}

// Resolve both runtimes from the same admitted occurrence.
async function runOccurrence(job: CronStoredJob) {
  const owner = { cfg: {}, agentId: "main" };
  const identity = { agentId: "main", sessionKey: RUN_KEY };
  const runRow = { sessionId: RUN_SESSION, updatedAt: 1 };
  fakeSessionOwner.rows.set(RUN_KEY, runRow);
  const occurrence = await admitScheduledOccurrence({ ...owner, job, trigger: "cron" });
  const admission = prepareCronRunAdmission({
    ...owner,
    runId: "run-1",
    sessionKey: RUN_KEY,
    jobId: job.id,
    deliveryAttemptFence: null,
    scheduledExecution: occurrence.mint({
      ...owner,
      runId: "run-1",
      runSessionKey: RUN_KEY,
    }),
  });
  const admitted = await admission.preparedRunAdmission.admit("embedded");
  const run = { config: {}, senderIsOwner: undefined, admittedRunContext: admitted };
  const embedded = await resolveEmbeddedAttemptMemoryAudience({
    run,
    ...identity,
    sessionId: runRow.sessionId,
    admission: { entry: runRow, storePath: STORE_PATH },
  });
  const cli = await resolveCliMcpMemoryAudience(
    { ...run, sessionId: runRow.sessionId, sessionEntry: runRow, storePath: STORE_PATH },
    identity,
  );
  return {
    audiences: [embedded.memoryAudience, cli.memoryAudience],
    settle: () => {
      embedded.release();
      cli.release();
      admission.close();
      occurrence.release();
    },
  };
}

function setParent(chatType: "direct" | "group") {
  const parent = {
    sessionId: PARENT_SESSION,
    lifecycleRevision: "rev-1",
    chatType,
    updatedAt: 1,
  };
  fakeSessionOwner.rows.set(PARENT_KEY, parent);
  return parent;
}

it("gives a v2026.10.6 operator-linked trusted job owner-private memory", async () => {
  // An operator's `cron.add --session-key` on v2026.10.6 stored a trusted policy and
  // no requester; the job keeps operator authority (resolved decision 2, refined).
  setParent("direct");
  const run = await runOccurrence(
    storedJob({
      owner: undefined,
      createdActor: undefined,
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    }),
  );
  expect(run.audiences).toEqual([
    { kind: "owner-private", agentId: "main" },
    { kind: "owner-private", agentId: "main" },
  ]);
  run.settle();
});

it("gives an agent-created job without a recorded requester only the conversation's memory", async () => {
  setParent("direct");
  const run = await runOccurrence(
    storedJob({
      createdActor: undefined,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: PARENT_KEY,
        ownerAccountId: "default",
      },
    }),
  );
  for (const audience of run.audiences) {
    expect(audience).toMatchObject({ kind: "conversation", sessionKey: PARENT_KEY });
  }
  run.settle();
});

it("gives a group conversation's child that conversation's memory, never owner-private", async () => {
  setParent("group");
  const run = await runOccurrence(storedJob());
  for (const audience of run.audiences) {
    expect(audience).toMatchObject({ kind: "conversation", sessionKey: PARENT_KEY });
  }
  run.settle();
});

it("refuses provider I/O on both runtimes once the parent resets mid-run", async () => {
  const parent = setParent("direct");
  const run = await runOccurrence(storedJob());
  const raw = provider();
  const bound = run.audiences.map((audience) => bindToRun(raw, audience!));
  fakeSessionOwner.rows.set(PARENT_KEY, {
    ...parent,
    sessionId: randomUUID(),
    lifecycleRevision: "rev-2",
  });
  for (const handle of bound) {
    await expect(handle.health()).rejects.toThrow("no longer current");
  }
  expect(raw.health).not.toHaveBeenCalled();
  run.settle();
});

it("drops owner-private memory on the next run after the requester loses owner status", async () => {
  setParent("direct");
  const first = await runOccurrence(storedJob());
  const raw = provider();
  expect(first.audiences).toEqual([
    { kind: "owner-private", agentId: "main" },
    { kind: "owner-private", agentId: "main" },
  ]);
  await expect(bindToRun(raw, first.audiences[0]!).health()).resolves.toMatchObject({
    status: "ready",
  });
  expect(raw.health).toHaveBeenCalledOnce();
  first.settle();
  expect(fakeSessionOwner.activeLeases).toBe(0);
  profiles.revoked.add(OWNER_PROFILE);
  const next = await runOccurrence(storedJob());
  for (const audience of next.audiences) {
    expect(audience).toMatchObject({ kind: "conversation", sessionKey: PARENT_KEY });
  }
  next.settle();
});

it.each([
  ["a job that stores only a parent session key", { sourceConversation: undefined }],
  ["a job with no recorded requester", { createdActor: undefined }],
])("keeps %s off the parent's private memory", async (_label, overrides) => {
  setParent("direct");
  const run = await runOccurrence(storedJob(overrides));
  for (const audience of run.audiences) {
    expect(audience).not.toEqual({ kind: "owner-private", agentId: "main" });
  }
  run.settle();
});
