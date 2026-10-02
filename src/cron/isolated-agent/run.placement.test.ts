import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  seedActivePlacement,
  SESSION_ID,
  SESSION_KEY,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  unusedEnvironments,
} from "../../gateway/worker-environments/worker-turn-launcher.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const session = await vi.importActual<typeof import("./session.js")>("./session.js");
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);

beforeEach(async () => {
  await setupWorkerTurnLauncherTest();
  resetRunCronIsolatedAgentTurnHarness();
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  mockRunCronFallbackPassthrough();
});
afterEach(cleanupWorkerTurnLauncherTest);

describe("current-bound cron placement", () => {
  it("admits sessions_send to the cron root after a detached scheduled turn", async () => {
    await seedActivePlacement();
    const sourcePlacement = placements.get(SESSION_ID);
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ placements, environments });
    const uninstall = installSessionPlacementAdmissionProvider(provider);
    const cfg: OpenClawConfig = {
      session: { store: sessionTarget.storePath },
      agents: { list: [{ id: "main", workspace: root }] },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    };
    setRuntimeConfigSnapshot(cfg);
    const cronKey = "agent:main:cron:placement-job";
    const executed: Array<{ sessionKey?: string; workspaceDir: string }> = [];
    const execute = async (params: RunEmbeddedAgentParams) => {
      assert(params.sessionKey);
      return withSessionPlacementTurnAdmission(
        params,
        { ...params, sessionFile: params.sessionKey },
        async () => {
          executed.push({ sessionKey: params.sessionKey, workspaceDir: params.workspaceDir });
          return { payloads: [{ text: "Scheduled check complete" }], meta: { durationMs: 1 } };
        },
      );
    };
    runEmbeddedAgentMock.mockImplementation(execute);
    try {
      const run = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg,
          agentId: "main",
          sessionKey: SESSION_KEY,
          job: makeIsolatedAgentJobFixture({
            id: "placement-job",
            sessionTarget: "current",
            sessionKey: SESSION_KEY,
            delivery: { mode: "none" },
          }),
        }),
      );
      expect(run.status, run.error).toBe("ok");
      assert(run.sessionId);
      const entry = accessor.loadSessionEntry({ ...sessionTarget, sessionKey: cronKey });
      expect(entry?.sessionId).not.toBe(SESSION_ID);
      expect(entry?.sessionId).toBe(run.sessionId);
      expect(placements.get(run.sessionId)).toMatchObject({
        state: "local",
        sessionKey: run.sessionKey,
        turnClaim: null,
      });

      const callGateway = vi.fn();
      callGateway.mockImplementation(
        async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
          if (request.method === "sessions.resolve") {
            return { key: cronKey, agentId: "main" };
          }
          if (request.method === "sessions.list") {
            return { sessions: [{ key: cronKey, agentId: "main", kind: "direct" }] };
          }
          if (request.method === "agent") {
            const sendParams = isRecord(request.params) ? request.params : {};
            const targetKey = sendParams.sessionKey;
            if (typeof targetKey !== "string") {
              throw new Error("Missing send target");
            }
            const target = accessor.loadSessionEntry({ ...sessionTarget, sessionKey: targetKey });
            if (!target) {
              throw new Error("Missing cron session");
            }
            const runId = String(sendParams.idempotencyKey);
            await execute({
              sessionId: target.sessionId,
              sessionKey: targetKey,
              agentId: "main",
              runId,
              workspaceDir: root,
              prompt: String(sendParams.message),
              timeoutMs: 0,
            });
            return { runId, status: "accepted" };
          }
          throw new Error(`Unexpected Gateway method: ${request.method}`);
        },
      );
      const tool = createSessionsSendTool({
        config: cfg,
        agentSessionKey: SESSION_KEY,
        expectedTargetSessionId: run.sessionId,
        callGateway,
      });
      for (const mode of [undefined, "followup"] as const) {
        const result = await tool.execute(`send-${mode ?? "default"}`, {
          sessionKey: cronKey,
          message: "Check the landing status",
          timeoutSeconds: 0,
          ...(mode ? { mode } : {}),
        });
        expect(result.details, JSON.stringify(result.details)).toMatchObject({
          status: "accepted",
          sessionKey: cronKey,
        });
      }
      const notification = await createSessionsSendTool({
        config: cfg,
        agentSessionKey: SESSION_KEY,
        callGateway,
      }).execute("notify", {
        sessionKey: cronKey,
        message: "Landing status changed",
        mode: "notify",
      });
      expect(notification.details).toMatchObject({
        status: "queued",
        sessionKey: cronKey,
        runStarted: false,
      });
      expect(executed).toEqual([
        { sessionKey: run.sessionKey, workspaceDir: root },
        { sessionKey: cronKey, workspaceDir: root },
        { sessionKey: cronKey, workspaceDir: root },
      ]);
      const unexpectedRun = vi.fn(async () => ({ meta: { durationMs: 0 } }));
      for (const sessionKey of [
        SESSION_KEY,
        "agent:main:cron:other-job",
        `${cronKey}:run:another-run`,
        `${run.sessionKey}:thread:other`,
      ]) {
        await expect(
          provider.executeLocalTurn(
            { sessionId: run.sessionId, sessionKey, agentId: "main", runId: "wrong-target" },
            unexpectedRun,
          ),
        ).rejects.toThrow("Worker turn session key does not match its placement");
      }
      await expect(
        provider.executeLocalTurn(
          {
            sessionId: run.sessionId,
            sessionKey: cronKey,
            agentId: "other",
            runId: "wrong-agent",
          },
          unexpectedRun,
        ),
      ).rejects.toThrow("Worker turn agent id does not match its placement");
      await expect(
        execute({
          sessionId: SESSION_ID,
          sessionKey: cronKey,
          agentId: "main",
          runId: "wrong-worker-target",
          workspaceDir: root,
          prompt: "Must not enter the source worker",
          timeoutMs: 0,
        }),
      ).rejects.toThrow("Worker turn session key does not match its placement");
      expect(unexpectedRun).not.toHaveBeenCalled();
      const rootOnly = {
        sessionId: "root-only-session",
        sessionKey: "agent:main:cron:root-only",
        agentId: "main",
        runId: "root-only-turn",
      };
      await accessor.replaceSessionEntry(
        { ...sessionTarget, sessionKey: rootOnly.sessionKey },
        { sessionId: rootOnly.sessionId, updatedAt: Date.now() },
      );
      await expect(provider.executeLocalTurn(rootOnly, async () => "local root")).resolves.toBe(
        "local root",
      );
      for (const suffix of [rootOnly.sessionId, "another-run"]) {
        await expect(
          provider.executeLocalTurn(
            { ...rootOnly, sessionKey: `${rootOnly.sessionKey}:run:${suffix}` },
            unexpectedRun,
          ),
        ).rejects.toThrow("Worker turn session key does not match its placement");
      }
      await accessor.patchSessionEntryCore({ ...sessionTarget, sessionKey: cronKey }, () => ({
        repositoryWorkspaceId: "repository-needs-worker",
      }));
      await expect(
        provider.executeLocalTurn(
          {
            sessionId: run.sessionId,
            sessionKey: cronKey,
            agentId: "main",
            runId: "repository-send",
          },
          unexpectedRun,
        ),
      ).rejects.toThrow("This repository session needs a cloud worker");
      expect(unexpectedRun).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toEqual(sourcePlacement);
      expect(environments.startTunnel).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});
