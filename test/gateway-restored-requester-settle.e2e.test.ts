// E2E: the shipped Gateway process bounds requester wakes restored from SQLite.
import type { ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeChildSession,
} from "../src/agents/subagents/registry/subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import { loadConfig } from "../src/config/io.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { redactSensitiveText } from "../src/logging/redact.js";
import type { Deferred } from "../src/shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { withSubagentRecoveryOperator } from "./helpers/subagent-recovery-operator.js";

const PROBE_MARKER = "restored wake ordering probe";
const RESTORED_WAKE_MARKER = "Every subagent in this batch has now settled";

type HeldModelServer = Awaited<ReturnType<typeof startHeldModelServer>>;

const instances: OpenClawTestInstance[] = [];
const modelServers: HeldModelServer[] = [];

afterEach(async () => {
  modelServers.forEach((server) => server.releaseAll());
  const cleanup = await Promise.allSettled(
    instances.splice(0).map((instance) => instance.cleanup()),
  );
  cleanup.push(
    ...(await Promise.allSettled(modelServers.splice(0).map((server) => server.close()))),
  );
  clearRuntimeConfigSnapshot();
  const cleanupErrors = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Restored requester fixture cleanup failed");
  }
});

describe("Gateway restored requester settlement", () => {
  it.each(["final", "runtime timeout", "stop"] as const)(
    "keeps restored completion execution under the normal runtime budget: %s",
    { timeout: 180_000 },
    async (outcome) => {
      const announceTimeoutMs = 2_000;
      const { modelServer, instance } = await setupGateway(
        `gateway-restored-deadline-${outcome.replaceAll(" ", "-")}`,
        { timeoutSeconds: 12, subagents: { announceTimeoutMs } },
      );
      // The final case also resumes a retained yielded fence and then admits a user follow-up.
      await seedRestoredRequesters(instance, 1, { yieldedFence: outcome === "final" });
      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      const sessionKey = "agent:main:gateway-restored-requester-0";
      const session = async () =>
        (
          await client.request<SessionsListResult>("sessions.list", { agentId: "main" })
        ).sessions.find((row) => row.key === sessionKey);
      try {
        await waitForGateway(instance, () => expect(modelServer.requestCount()).toBe(1));
        await expect(session()).resolves.toMatchObject({ status: "running", hasActiveRun: true });
        // This elapsed wait is the regression itself: the real model socket must
        // remain open beyond the announcement budget, without a new sender turn.
        await vi.waitFor(
          () => expect(modelServer.requestAgeMs(0)).toBeGreaterThan(announceTimeoutMs),
          { timeout: announceTimeoutMs + 5_000, interval: 20 },
        );
        expect(modelServer.closed(0), instance.logs()).toBe(false);
        expect(modelServer.requestCount()).toBe(1);
        if (outcome === "final") {
          modelServer.release(0);
        } else if (outcome === "stop") {
          expect(await client.request("chat.abort", { sessionKey })).toMatchObject({
            aborted: true,
          });
        }
        const expectedStatus =
          outcome === "final" ? "done" : outcome === "stop" ? "killed" : "timeout";
        await vi.waitFor(
          async () =>
            expect(await session()).toMatchObject({ status: expectedStatus, hasActiveRun: false }),
          { timeout: 20_000, interval: 50 },
        );
        await vi.waitFor(() => expect(modelServer.closed(0)).toBe(true), { timeout: 5_000 });
        const history = await client.request<{
          messages: Array<{ role: string; content?: Array<{ type: string; text?: string }> }>;
        }>("chat.history", { sessionKey });
        const finals = history.messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.content?.some((part) => part.text === "restored requester response 0"),
        );
        expect(finals).toHaveLength(outcome === "final" ? 1 : 0);

        // A terminal wake must release its session lane for ordinary follow-up.
        const followUp = client.request(
          "agent",
          {
            sessionKey,
            idempotencyKey: `restored-deadline-followup-${outcome}`,
            message: PROBE_MARKER,
            deliver: false,
          },
          { expectFinal: true },
        );
        void followUp.catch(() => {});
        try {
          await vi.waitFor(() => expect(modelServer.requestCount()).toBe(2), { timeout: 10_000 });
          modelServer.release(1);
          await expect(followUp).resolves.toMatchObject({ status: "ok" });
          expect(modelServer.requestCount()).toBe(2);
        } finally {
          modelServer.releaseAll();
          await Promise.allSettled([followUp]);
        }
      } finally {
        await disconnectGatewayClient(client);
        modelServer.releaseAll();
        await instance.stopGateway();
      }
      try {
        const retained = loadSubagentRegistryFromSqlite().get("run-gateway-restored-settle-0");
        expect(retained?.execution.outcome).toEqual({ status: "ok" });
        expect(retained?.completion?.resultText).toBe("done");
        if (outcome === "final") {
          expect(retained?.requesterSettleWake).toBeUndefined();
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it(
    "runs at most two restored wakes while leaving the third queued",
    { timeout: 180_000 },
    async () => {
      const { modelServer, instance } = await setupGateway("gateway-restored-requester-settle");
      await seedRestoredRequesters(instance, 3);

      await instance.startGateway();
      await waitForGateway(
        instance,
        () => expect(modelServer.countRequestsContaining(RESTORED_WAKE_MARKER)).toBe(2),
        20,
      );
      expect(modelServer.active(), instance.logs()).toBe(2);
      expect(modelServer.peakRestored(), instance.logs()).toBe(2);

      const probe = instance.cli(["agent", "--message", PROBE_MARKER, "--json"]);
      await vi.waitFor(() => expect(modelServer.countRequestsContaining(PROBE_MARKER)).toBe(1), {
        interval: 20,
        timeout: 30_000,
      });
      expect(modelServer.countRequestsContaining(RESTORED_WAKE_MARKER)).toBe(2);

      modelServer.release(0);
      await vi.waitFor(
        () => expect(modelServer.countRequestsContaining(RESTORED_WAKE_MARKER)).toBe(3),
        { interval: 20, timeout: 30_000 },
      );
      expect(modelServer.peakRestored(), instance.logs()).toBe(2);
      modelServer.releaseAll();
      await expect(probe).resolves.toMatchObject({ code: 0 });
    },
  );
});

async function setupGateway(
  name: string,
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
) {
  const modelServer = await startHeldModelServer();
  modelServers.push(modelServer);
  const config = createOpenAiResponsesModelConfig({
    baseUrl: modelServer.url,
    providerId: "restored-settle",
    modelId: "restored-settle",
    reasoning: false,
    toolProfile: "minimal",
  });
  config.plugins = { enabled: false };
  Object.assign(config.agents!.defaults!, { maxConcurrent: 8 }, defaults);
  const instance = await createOpenClawTestInstance({
    name,
    config,
    env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  instances.push(instance);
  return { modelServer, instance };
}

async function waitForGateway(
  instance: OpenClawTestInstance,
  assertion: () => void,
  interval?: number,
) {
  await vi.waitFor(assertion, { timeout: 30_000, interval }).catch((error: unknown) => {
    const readiness = instance.readiness.map(
      ({ outcome, elapsedMs, attempts, lastProbe, child }) => ({
        outcome,
        elapsedMs,
        attempts,
        lastProbe,
        child,
      }),
    );
    // Snapshot the existing bounded child buffers before normal fixture cleanup removes state.
    let diagnostic = redactSensitiveText(
      `${instance.name}\n${JSON.stringify({ readiness })}\n${instance.logs()}`,
      { mode: "tools" },
    );
    for (const token of [instance.gatewayToken, instance.hookToken]) {
      if (token) {
        diagnostic = diagnostic.replaceAll(token, "[fixture token]");
      }
    }
    throw new Error(diagnostic, { cause: error });
  });
}

async function seedRestoredRequesters(
  instance: OpenClawTestInstance,
  count: number,
  options: { yieldedFence?: boolean } = {},
) {
  instance.state.applyEnv();
  const gatewayConfig = loadConfig();
  const stateDir = instance.stateDir;
  setRuntimeConfigSnapshot(gatewayConfig);
  const registry =
    await import("../src/agents/subagents/registry/subagent-registry.test-helpers.js");
  await runQaGatewayFixture(
    async () => {
      await registry.resetSubagentRegistryForTests({ persist: false });
      const restoredRuns = new Map<string, SubagentRunRecord>();
      await withSubagentRecoveryOperator(gatewayConfig, async (profileId) => {
        for (let index = 0; index < count; index += 1) {
          const requesterEndedAt = Date.now();
          const runId = `run-gateway-restored-settle-${index}`;
          const requesterName = `gateway-restored-requester-${index}`;
          const requesterSessionKey = `agent:main:${requesterName}`;
          const requesterTurnRunId = `yielded-${runId}`;
          const childSessionKey = `agent:main:subagent:gateway-restored-settle-${index}`;
          const storePath = await writeChildSession(stateDir, requesterSessionKey, requesterName);
          if (options.yieldedFence) {
            await replaceSessionEntry(
              { storePath, sessionKey: requesterSessionKey },
              {
                sessionId: requesterName,
                updatedAt: requesterEndedAt,
                endedAt: requesterEndedAt,
                abortedLastRun: false,
                activeWriterRunId: requesterTurnRunId,
                lifecycleRunId: requesterTurnRunId,
                restartRecoveryRuns: [
                  {
                    runId: requesterTurnRunId,
                    lifecycleGeneration: "generation-before-restart",
                  },
                ],
              },
            );
          }
          await writeChildSession(stateDir, childSessionKey, `gateway-restored-child-${index}`);
          const requester = expectDefined(
            loadSessionEntry({ agentId: "main", sessionKey: requesterSessionKey }),
            "restored requester session",
          );
          // Admission captures the exact requester and operator source before the process restart.
          await registry.registerSubagentRun({
            runId,
            childSessionKey,
            childAgentId: "main",
            sessionEntry: loadSessionEntry({ agentId: "main", sessionKey: childSessionKey }),
            requesterSessionKey,
            requesterAgentId: "main",
            requesterDisplayKey: requesterName,
            requesterTurnRunId,
            completionRequesterSessionId: requester.sessionId,
            completionRequesterLifecycleRevision: requester.lifecycleRevision,
            task: "resume a durable requester wake through the Gateway CLI",
            cleanup: "keep",
            expectsCompletionMessage: true,
            queued: true,
          });
          const registered = expectDefined(
            loadSubagentRegistryFromSqlite().get(runId),
            "persisted restored child registration",
          );
          expect(registered.operatorRecoverySource).toMatchObject({
            agentId: "main",
            sessionKey: requesterSessionKey,
            sessionId: requester.sessionId,
            sourceRunId: requesterTurnRunId,
            snapshot: { profileId, scopes: ["operator.write"], grant: null },
          });
          expect(registered.requesterStorePath).toBeTruthy();
          expect(registered.controllerStorePath).toBe(registered.requesterStorePath);
          const endedAt = Date.now();
          restoredRuns.set(runId, {
            ...registered,
            requesterTurnRunId: undefined,
            endedReason: "subagent-complete",
            execution: {
              ...registered.execution,
              status: "terminal",
              startedAt: registered.createdAt,
              endedAt,
              outcome: { status: "ok" },
            },
            completion: { required: true, resultText: "done", capturedAt: endedAt },
            delivery: { status: "delivered", deliveredAt: endedAt },
            cleanupHandled: true,
            cleanupCompletedAt: endedAt,
            requesterSettleWake: {
              status: "pending",
              attemptCount: 0,
              batchRunIds: [runId],
              requesterYieldBatch: true,
              afterRequesterYield: true,
              rearmGeneration: 1,
            },
          });
        }
      });
      // Release setup callbacks before restoring the retained completion obligations from disk.
      await registry.resetSubagentRegistryForTests({ persist: false });
      saveSubagentRegistryToSqlite(restoredRuns);
    },
    () => settleSubagentRegistryPersistenceWork(),
    () => registry.resetSubagentRegistryForTests({ persist: false }),
    // instance.cleanup retains the state lease through Gateway execution and result reads.
    () => closeOpenClawStateDatabaseForTest(),
  );
}

async function startHeldModelServer() {
  const requests: {
    release: Deferred;
    body: string;
    response: ServerResponse;
    startedAt: number;
  }[] = [];
  let active = 0;
  let activeRestored = 0;
  let peakRestored = 0;
  const server = await startOpenAiResponsesModelServer({
    modelId: "restored-settle",
    bindError: "restored requester model server did not bind",
    onRequest: async (request, response) => {
      let body = "";
      for await (const chunk of request) {
        body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      }
      const index = requests.length;
      const release = createDeferred();
      requests.push({ release, body, response, startedAt: Date.now() });
      active += 1;
      const isRestored = body.includes(RESTORED_WAKE_MARKER);
      if (isRestored) {
        activeRestored += 1;
        peakRestored = Math.max(peakRestored, activeRestored);
      }
      try {
        await release.promise;
        if (!response.destroyed) {
          writeOpenAiResponsesText(response, {
            text: `restored requester response ${index}`,
            messageId: `restored-requester-message-${index}`,
            responseId: `restored-requester-response-${index}`,
          });
        }
      } finally {
        active -= 1;
        if (isRestored) {
          activeRestored -= 1;
        }
      }
    },
  });
  const releaseAll = () => requests.forEach(({ release }) => release.resolve(undefined));
  return {
    active: () => active,
    closed: (index: number) => requests[index]?.response.destroyed ?? false,
    requestAgeMs: (index: number) => Date.now() - (requests[index]?.startedAt ?? Date.now()),
    countRequestsContaining: (marker: string) =>
      requests.filter(({ body }) => body.includes(marker)).length,
    peakRestored: () => peakRestored,
    release: (index: number) => requests[index]?.release.resolve(undefined),
    releaseAll,
    requestCount: () => requests.length,
    url: server.baseUrl,
    close: async () => {
      releaseAll();
      await server.close();
    },
  };
}
