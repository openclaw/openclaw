// Registered in agent.test.ts's existing handler suite and cleanup lifetime.
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  seedPersistedSubagentRunForAgentTest,
  withPluginSubagentTestState,
} from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  expectRespondError,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  requireValue,
  waitForAssertion,
} from "./agent.test-harness.js";
import { getAgentTestStorePath } from "./agent.user-turn-recorder.test-support.js";

const mocks = getAgentTestMocks();

export function registerPluginSubagentPersistenceFailureTest() {
  it("rejects plugin SDK subagent registration and adoption when persistence fails", async () => {
    await withPluginSubagentTestState(
      "openclaw-gateway-plugin-subagent-registry-fail-",
      async () => {
        await resetSubagentRegistryForTests({ persist: false });
        const persistenceError = Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
        mocks.registryWrite.mockImplementationOnce(() => {
          throw persistenceError;
        });
        const runId = "plugin-subagent-registry-fail";
        const childSessionKey = "agent:main:subagent:registry-fail";
        const cfg = {
          session: { mainKey: "main", scope: "per-sender" },
        } satisfies typeof mocks.loadConfigReturn;
        mocks.loadConfigReturn = cfg;
        mocks.loadSessionEntry.mockReturnValue({
          cfg,
          storePath: getAgentTestStorePath(),
          entry: {
            sessionId: "plugin-subagent-registry-fail-session",
            updatedAt: Date.now(),
          },
          canonicalKey: childSessionKey,
        });
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            [childSessionKey]: {
              sessionId: "plugin-subagent-registry-fail-session",
              updatedAt: Date.now(),
            },
          };
          return await updater(store);
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });
        const context = makeContext();
        const baseClient = requireValue(backendGatewayClient(), "expected backend client");
        const commandCallCount = mocks.agentCommand.mock.calls.length;
        const respond = vi.fn();

        await invokeAgent(
          {
            message: "background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            context,
            reqId: runId,
            respond,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(mocks.registryWrite).toHaveBeenCalledTimes(1);
        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
        expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false);
        expect(context.chatAbortControllers.has(runId)).toBe(false);
        expectRespondError(respond, {
          code: ErrorCodes.UNAVAILABLE,
          message:
            "plugin subagent registry persistence failed; run was not started | Queued subagent registry persistence failed: disk full | SQLITE_FULL",
        });
        expect(context.logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("rejecting untracked dispatch"),
        );

        await resetSubagentRegistryForTests({ persist: false });
        const pausedRunId = "plugin-subagent-paused-before-persistence-failure";
        await seedPersistedSubagentRunForAgentTest({
          runId: pausedRunId,
          childSessionKey,
          requesterSessionKey: "agent:main:telegram:direct:777",
          requesterDisplayKey: "agent:main:telegram:direct:777",
          task: "wait for the remote job",
          endedAt: 2_000,
          pauseReason: "sessions_yield",
          expectsCompletionMessage: true,
        });
        mocks.registryWrite.mockClear();
        mocks.registryWrite.mockImplementationOnce(() => {
          throw new Error("disk full during paused-run adoption");
        });
        const adoptionRunId = "plugin-subagent-adoption-registry-fail";
        const adoptionRespond = vi.fn();
        await invokeAgent(
          {
            message: "the remote job finished",
            sessionKey: childSessionKey,
            idempotencyKey: adoptionRunId,
          },
          {
            context,
            reqId: adoptionRunId,
            respond: adoptionRespond,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount);
        expect(await getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
          runId: pausedRunId,
          pauseReason: "sessions_yield",
        });
        expect((await getSubagentRunByChildSessionKey(childSessionKey))?.runId).not.toBe(
          adoptionRunId,
        );
        expect(mocks.registryWrite).toHaveBeenCalledOnce();
        const storedRuns = loadSubagentRegistryFromSqlite();
        expect(storedRuns.has(adoptionRunId)).toBe(false);
        expect(storedRuns.get(pausedRunId)).toMatchObject({
          runId: pausedRunId,
          pauseReason: "sessions_yield",
        });
        expectRespondError(adoptionRespond, {
          code: ErrorCodes.UNAVAILABLE,
          message:
            "plugin subagent registry persistence failed; run was not started | Queued subagent registry persistence failed: disk full during paused-run adoption",
        });

        await resetSubagentRegistryForTests({ persist: false });
        const retryRunId = "plugin-subagent-registry-retry";
        await invokeAgent(
          {
            message: "retry background plugin subagent task",
            sessionKey: childSessionKey,
            idempotencyKey: retryRunId,
          },
          {
            context,
            reqId: retryRunId,
            client: {
              connect: baseClient.connect,
              internal: {
                ...baseClient.internal,
                agentRunTracking: "plugin_subagent",
                pluginRuntimeOwnerId: "memory-core",
              },
            },
          },
        );

        expect(mocks.registryWrite.mock.calls.length).toBeGreaterThan(1);
        await waitForAssertion(() => {
          expect(mocks.agentCommand).toHaveBeenCalledTimes(commandCallCount + 1);
          const retryRun = requireValue(
            subagentRuns.get(retryRunId),
            "expected retry plugin subagent run",
          );
          expect(retryRun.runId).toBe(retryRunId);
        });
      },
    );
  });
}
