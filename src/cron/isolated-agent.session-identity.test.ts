// Isolated agent session identity tests cover stable session ids for cron runs.
import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it as baseIt, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams as AgentRequest } from "../agents/embedded-agent-runner/run/internal-params.js";
import { SessionManager } from "../agents/sessions/index.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { admitScheduledOccurrence } from "./execution-context-admission.js";
import {
  readScheduledMemoryParent,
  readScheduledToolTargets,
} from "./execution-context-registry.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import * as f from "./isolated-agent.test-harness.js";
import {
  DEFAULT_MESSAGE,
  makeDeps,
  mockEmbeddedOk,
  readCronSessionEntry,
  runCronTurn,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import * as h from "./isolated-agent/run.test-harness.js";
import { normalizeCronJobCreate } from "./normalize.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import type { CronJob, CronStoredJob } from "./types.js";

setupRunCronIsolatedAgentTurnSuite();
const prepareProfiles = useUserProfileCatalogForTest();
const it = baseIt.extend<{ home: string }>({
  home: async ({ task: _task }, use) => {
    await withTempHome(use);
  },
});

async function useRealCronSessionState(): Promise<void> {
  const [sessionRuntime, sessionAccessor] = await Promise.all([
    vi.importActual<typeof import("./isolated-agent/session.js")>("./isolated-agent/session.js"),
    vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
      "../config/sessions/session-accessor.js",
    ),
  ]);
  h.resolveCronSessionMock.mockImplementation(sessionRuntime.resolveCronSession);
  h.loadSessionEntryMock.mockImplementation(sessionRuntime.loadCronSessionEntryLatest);
  h.patchSessionEntryMock.mockImplementation(sessionAccessor.patchSessionEntryCore);
}

function lastEmbeddedAgentCall(): AgentRequest {
  return h.runEmbeddedAgentMock.mock.calls.at(-1)?.[0];
}

function embeddedResult(sessionId: string | undefined, extra = {}) {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId, provider: "anthropic", model: "claude-opus-4-6", ...extra },
    },
  };
}

function sessionJob(
  overrides: Partial<CronStoredJob> = {},
  message = DEFAULT_MESSAGE,
): CronStoredJob {
  return { ...f.makeJob({ kind: "agentTurn", message }), delivery: { mode: "none" }, ...overrides };
}

function runSessionTurn(
  cfg: Parameters<typeof runCronIsolatedAgentTurn>[0]["cfg"],
  job: CronStoredJob,
  sessionKey = "cron:job-1",
  agentId?: string,
  occurrence = TEST_SCHEDULED_OCCURRENCE,
) {
  setRuntimeConfigSnapshot(cfg);
  return runCronIsolatedAgentTurn({
    occurrence,
    deliveryAttemptFence: null,
    cfg,
    deps: makeDeps(),
    job,
    message: job.payload.kind === "agentTurn" ? job.payload.message : DEFAULT_MESSAGE,
    sessionKey,
    agentId,
    lane: "cron",
  });
}

describe("runCronIsolatedAgentTurn session identity", () => {
  beforeEach(() => {
    h.mockRunCronFallbackPassthrough();
  });

  it("uses agentId for workspace, session key, and store paths", async ({ home }) => {
    const agentId = "ops";
    const sessionKey = "cron:job-ops";
    const workspaceDir = path.join(home, `${agentId}-workspace`);
    mockEmbeddedOk();

    const cfg = f.makeCfg(
      home,
      path.join(home, ".openclaw", "agents", "{agentId}", "sessions", "sessions.json"),
      {
        agents: {
          defaults: { workspace: path.join(home, "default-workspace") },
          entries: { main: {}, [agentId]: { workspace: workspaceDir } },
        },
      },
    );

    const res = await runSessionTurn(cfg, sessionJob({ agentId }), sessionKey, agentId);

    expect(res.status).toBe("ok");
    const call = lastEmbeddedAgentCall();
    expect(call.sessionKey).toMatch(new RegExp(`^agent:${agentId}:`));
    expect(call.workspaceDir).toBe(workspaceDir);
    expect(call.sessionTarget).toEqual({
      agentId,
      sessionId: call.sessionId,
      sessionKey: call.sessionKey,
      storePath: path.join(home, ".openclaw", "agents", agentId, "sessions", "sessions.json"),
    });
  });

  it.for(["profile", "channel"] as const)(
    "retains %s provenance and sandboxing on both cron owners before running",
    async (source, { home }) => {
      await useRealCronSessionState();
      await prepareProfiles();
      const storePath = await f.writeSessionStore(home, {});
      const profile = ensureProfileForEmail("cron-creator@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const createdActor = { type: "human" as const, source, id: profile.id };
      const job = sessionJob({ createdActor });
      const guest = {
        sessions: { others: "none" as const },
        agents: "*" as const,
        scopes: [],
        sandbox: "required" as const,
      };
      const cfg = f.makeCfg(home, storePath, {
        gateway: { roles: { default: "guest", definitions: { guest } } },
      });
      h.runEmbeddedAgentMock.mockImplementationOnce(async (input: AgentRequest) => {
        const sessionKey = input.sessionKey ?? "";
        expect(sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
        for (const key of ["agent:main:cron:job-1", sessionKey]) {
          const entry = loadSessionEntry({ storePath, sessionKey: key });
          expect(entry).toMatchObject({
            createdVia: "cron",
            createdActor,
            sandbox: "required",
          });
        }
        return embeddedResult(input.sessionId);
      });
      const res = await runSessionTurn(cfg, job);
      expect(res.status, res.status === "error" ? res.error : undefined).toBe("ok");
      expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      const entry = await readCronSessionEntry(storePath, "agent:main:cron:job-1");
      expect(entry).toMatchObject({ createdActor, sandbox: "required" });
      await expect(readCronSessionEntry(storePath, res.sessionKey!)).resolves.toBeUndefined();
    },
  );

  it("persists rotated transcript identity for current-bound cron runs", async ({ home }) => {
    const boundSessionKey = "agent:main:telegram:direct:42";
    const rotated = { sessionId: "bound-session-rotated" };
    const rotatedSessionFile = path.join(home, "bound-session-rotated.jsonl");
    await fs.writeFile(rotatedSessionFile, "");
    const storePath = await f.writeSessionStoreEntries(home, {
      [boundSessionKey]: {
        sessionId: "bound-session",
        sessionFile: path.join(home, "bound-session.jsonl"),
        updatedAt: Date.now(),
        lastInteractionAt: Date.now() - 1_000,
        systemSent: true,
      },
    });
    const currentBoundJob = normalizeCronJobCreate(sessionJob({ sessionTarget: "current" }), {
      sessionContext: { sessionKey: boundSessionKey },
    }) as CronJob;
    const executionSessionKey = `agent:main:cron:${currentBoundJob.id}`;
    h.runEmbeddedAgentMock.mockImplementationOnce(async (input: AgentRequest) => {
      const { agentId = "main", sessionId, sessionKey = "" } = input;
      const target = { agentId, sessionId, sessionKey, storePath };
      const manager = SessionManager.open(target, input.workspaceDir);
      manager.appendMessage({ role: "user", content: "turn", timestamp: Date.now() });
      return embeddedResult(rotated.sessionId, {
        sessionFile: rotatedSessionFile,
        compactionCount: 1,
        compactionTokensAfter: 42,
      });
    });

    const res = await runSessionTurn(f.makeCfg(home, storePath), currentBoundJob, boundSessionKey);

    expect(res).toMatchObject({ status: "ok", ...rotated });
    expect(h.dispatchCronDeliveryMock.mock.calls.at(-1)?.[0]).toMatchObject(rotated);

    await expect(readCronSessionEntry(storePath, executionSessionKey)).resolves.toMatchObject(
      rotated,
    );
    await expect(readCronSessionEntry(storePath, boundSessionKey)).resolves.toMatchObject({
      sessionId: "bound-session",
    });
  });

  it("runs a linked current job as a child of its conversation", async ({ home }) => {
    const parentKey = "agent:main:dashboard:creator";
    const parentWorkspace = path.join(home, "creator-workspace");
    await fs.mkdir(parentWorkspace, { recursive: true });
    const parentRow = {
      sessionId: "creator-session",
      lifecycleRevision: "rev-1",
      updatedAt: Date.now() - 1_000,
      spawnedWorkspaceDir: parentWorkspace,
      spawnedCwd: parentWorkspace,
      systemSent: true,
    };
    const storePath = await f.writeSessionStoreEntries(home, { [parentKey]: parentRow });
    const cfg = f.makeCfg(home, storePath);
    const job: CronStoredJob = {
      ...(normalizeCronJobCreate(sessionJob({ sessionTarget: "current" }), {
        sessionContext: { sessionKey: parentKey },
      }) as CronJob),
      sourceConversation: {
        sessionKey: parentKey,
        sessionId: "creator-session",
        lifecycleRevision: "rev-1",
      },
    };
    const occurrence = await admitScheduledOccurrence({
      cfg,
      job,
      agentId: "main",
      trigger: "cron",
    });
    let seen: Record<string, unknown> | undefined;
    h.runEmbeddedAgentMock.mockImplementationOnce(async (input: AgentRequest) => {
      const admitted = await input.preparedRunAdmission!.admit("gateway", input.runId);
      seen = {
        sessionKey: input.sessionKey,
        workspaceDir: input.workspaceDir,
        board: readScheduledToolTargets(admitted)?.boardSessionKey,
        placement: readScheduledToolTargets(admitted)?.placement,
        memory: readScheduledMemoryParent(admitted.operationalRunInstance)?.sessionKey,
      };
      return embeddedResult(input.sessionId);
    });

    let res;
    try {
      res = await runSessionTurn(cfg, job, parentKey, undefined, occurrence);
    } finally {
      occurrence.release();
    }

    expect(res.status, res.error).toBe("ok");
    // The child runs under its own run key, so it never joins a live parent turn,
    // and takes the parent's board, memory and workspace.
    expect(seen).toEqual({
      sessionKey: expect.stringMatching(new RegExp(`^agent:main:cron:${job.id}:run:`)),
      workspaceDir: parentWorkspace,
      board: parentKey,
      placement: "child",
      memory: parentKey,
    });
    await expect(readCronSessionEntry(storePath, parentKey)).resolves.toMatchObject(parentRow);
  });

  it("uses lightweight bootstrap context for command-style cron payloads", async ({ home }) => {
    await runCronTurn(home, {
      jobPayload: {
        kind: "agentTurn",
        message: "cd /srv/openclaw && ./scripts/nightly-report.sh",
      },
    });

    expect(lastEmbeddedAgentCall().bootstrapContextMode).toBe("lightweight");
  });

  it("starts a fresh session id for each cron run", async ({ home }) => {
    await useRealCronSessionState();
    const storePath = await f.writeSessionStore(home, { delivery: { kind: "internal" } });
    const first = (await runCronTurn(home, { storePath })).res;
    const second = (await runCronTurn(home, { storePath })).res;

    expect([typeof first.sessionId, typeof second.sessionId]).toEqual(["string", "string"]);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(first.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
    expect(second.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
    expect(second.sessionKey).not.toBe(first.sessionKey);
  });
});
