// Isolated agent session identity tests cover stable session ids for cron runs.
import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams as AgentRequest } from "../agents/embedded-agent-runner/run/internal-params.js";
import * as modelThinkingDefault from "../agents/model-thinking-default.js";
import { SessionManager } from "../agents/sessions/index.js";
import * as thinking from "../auto-reply/thinking.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { useUserProfileCatalogForTest } from "../test-utils/user-profile-catalog.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  writeSessionStore,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  DEFAULT_MESSAGE,
  makeDeps,
  mockEmbeddedOk,
  readCronSessionEntry,
  runCronTurn,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import { normalizeCronJobCreate } from "./normalize.js";
import type { CronJob, CronStoredJob } from "./types.js";

setupRunCronIsolatedAgentTurnSuite();
const prepareProfiles = useUserProfileCatalogForTest();

async function useRealCronSessionState(): Promise<void> {
  const [sessionRuntime, sessionAccessor] = await Promise.all([
    vi.importActual<typeof import("./isolated-agent/session.js")>("./isolated-agent/session.js"),
    vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
      "../config/sessions/session-accessor.js",
    ),
  ]);
  resolveCronSessionMock.mockImplementation(sessionRuntime.resolveCronSession);
  loadSessionEntryMock.mockImplementation(sessionRuntime.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(sessionAccessor.patchSessionEntryCore);
}

function lastEmbeddedAgentCall(): AgentRequest {
  return runEmbeddedAgentMock.mock.calls.at(-1)?.[0];
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

function runSessionTurn(
  cfg: Parameters<typeof runCronIsolatedAgentTurn>[0]["cfg"],
  job: CronStoredJob,
  sessionKey = "cron:job-1",
  agentId?: string,
) {
  setRuntimeConfigSnapshot(cfg);
  return runCronIsolatedAgentTurn({
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
    vi.spyOn(modelThinkingDefault, "resolveThinkingDefault").mockReturnValue("off");
    vi.spyOn(thinking, "isThinkingLevelSupported").mockReturnValue(true);
    runEmbeddedAgentMock.mockClear();
    mockRunCronFallbackPassthrough();
  });

  it("uses agentId for workspace, session key, and store paths", async () => {
    const agentId = "ops";
    const sessionKey = "cron:job-ops";
    await withTempHome(async (home) => {
      const workspaceDir = path.join(home, `${agentId}-workspace`);
      mockEmbeddedOk();

      const cfg = makeCfg(
        home,
        path.join(home, ".openclaw", "agents", "{agentId}", "sessions", "sessions.json"),
        {
          agents: {
            defaults: { workspace: path.join(home, "default-workspace") },
            entries: { main: {}, [agentId]: { workspace: workspaceDir } },
          },
        },
      );

      const res = await runSessionTurn(
        cfg,
        { ...makeJob(DEFAULT_AGENT_TURN_PAYLOAD), agentId, delivery: { mode: "none" } },
        sessionKey,
        agentId,
      );

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
  });

  it.each(["profile", "channel"] as const)(
    "retains %s provenance and sandboxing on both cron owners before running",
    async (source) => {
      await useRealCronSessionState();
      await withTempHome(async (home) => {
        await prepareProfiles();
        const storePath = await writeSessionStore(home, { delivery: { kind: "internal" } });
        const profile = ensureProfileForEmail("cron-creator@example.test");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const createdActor = { type: "human" as const, source, id: profile.id };
        const job: CronStoredJob = {
          ...makeJob({ kind: "agentTurn", message: "persist this turn" }),
          createdActor,
          delivery: { mode: "none" },
        };
        const cfg = makeCfg(home, storePath, {
          gateway: {
            roles: {
              default: "guest",
              definitions: {
                guest: {
                  sessions: { others: "none" },
                  agents: "*",
                  scopes: [],
                  sandbox: "required",
                },
              },
            },
          },
        });
        runEmbeddedAgentMock.mockImplementationOnce(async (input: AgentRequest) => {
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
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        const entry = await readCronSessionEntry(storePath, "agent:main:cron:job-1");
        expect(entry).toMatchObject({ createdActor, sandbox: "required" });
        await expect(readCronSessionEntry(storePath, res.sessionKey!)).resolves.toBeUndefined();
      });
    },
  );

  it("persists rotated transcript identity for current-bound cron runs", async () => {
    await withTempHome(async (home) => {
      const boundSessionKey = "agent:main:telegram:direct:42";
      const originalSessionFile = path.join(home, "bound-session.jsonl");
      const rotatedSessionFile = path.join(home, "bound-session-rotated.jsonl");
      await fs.writeFile(rotatedSessionFile, "");
      const storePath = await writeSessionStoreEntries(home, {
        [boundSessionKey]: {
          sessionId: "bound-session",
          sessionFile: originalSessionFile,
          updatedAt: Date.now(),
          lastInteractionAt: Date.now() - 1_000,
          systemSent: true,
        },
      });
      const currentBoundJob = normalizeCronJobCreate(
        {
          ...makeJob(DEFAULT_AGENT_TURN_PAYLOAD),
          sessionTarget: "current",
          delivery: { mode: "none" },
        },
        { sessionContext: { sessionKey: boundSessionKey } },
      ) as CronJob;
      const executionSessionKey = `agent:main:cron:${currentBoundJob.id}`;
      runEmbeddedAgentMock.mockImplementationOnce(async (input: AgentRequest) => {
        const { agentId = "main", sessionId, sessionKey = "", workspaceDir } = input;
        const manager = SessionManager.open(
          { agentId, sessionId, sessionKey, storePath },
          workspaceDir,
        );
        manager.appendMessage({
          role: "user",
          content: "current-bound transcript",
          timestamp: Date.now(),
        });
        return embeddedResult("bound-session-rotated", {
          sessionFile: rotatedSessionFile,
          compactionCount: 1,
          compactionTokensAfter: 42,
        });
      });

      const res = await runSessionTurn(makeCfg(home, storePath), currentBoundJob, boundSessionKey);

      expect(res).toMatchObject({ status: "ok", sessionId: "bound-session-rotated" });
      expect(dispatchCronDeliveryMock.mock.calls.at(-1)?.[0]).toMatchObject({
        sessionId: "bound-session-rotated",
      });

      await expect(readCronSessionEntry(storePath, executionSessionKey)).resolves.toMatchObject({
        sessionId: "bound-session-rotated",
      });
      await expect(readCronSessionEntry(storePath, boundSessionKey)).resolves.toMatchObject({
        sessionId: "bound-session",
      });
    });
  });

  it("uses lightweight bootstrap context for command-style cron payloads", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: "cd /srv/openclaw && ./scripts/nightly-report.sh",
        },
      });

      expect(lastEmbeddedAgentCall().bootstrapContextMode).toBe("lightweight");
    });
  });

  it("starts a fresh session id for each cron run", async () => {
    await useRealCronSessionState();
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { delivery: { kind: "internal" } });
      const deps = makeDeps();
      const runPingTurn = () =>
        runCronTurn(home, {
          deps,
          jobPayload: { kind: "agentTurn", message: "ping" },
          storePath,
        });

      const first = (await runPingTurn()).res;
      const second = (await runPingTurn()).res;

      expect(first.sessionId).toBeTypeOf("string");
      expect(second.sessionId).toBeTypeOf("string");
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(first.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).not.toBe(first.sessionKey);
    });
  });
});
