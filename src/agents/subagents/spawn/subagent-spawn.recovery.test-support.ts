import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { createOperatorRecoveryFixture } from "../../../gateway/operator-run-recovery.test-support.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { peekSystemEventEntries } from "../../../infra/system-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { getRpcSource } from "../../../sessions/session-controller.rpc-sources.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import {
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
  resolvePreparedRunAdmission,
} from "../../admitted-run-context.js";
import { commitMainSessionRecovery } from "../../main-session-recovery/main-session-recovery-store.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { resolveSubagentSessionStatus } from "../registry/subagent-session-metrics.js";
import {
  recordSpawnBoundaryFinal,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerRecoverySpawnCases(
  options: NativePluginSpawnTestOptions & { stateDir: () => string },
) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    throwBoundFailures,
    runEmbeddedAgent,
    settleRootWork,
  } = options;
  it.for(["complete", "stop"] as const)(
    "lets a recovered requester finish before its spawned child: %s",
    async (outcome, { signal: testSignal }) => {
      const stateDir = options.stateDir();
      const bound = await createBoundParent();
      const { context, runtime } = await createBoundGateway(bound);
      const profile = ensureProfileForEmail("recovered-spawn@example.test");
      setUserProfileRole(profile.id, "operator");
      const fixture = await createOperatorRecoveryFixture({
        stateDir,
        context,
        profileId: profile.id,
        config: bound.cfg,
        sessionKey: "agent:main:recovered-spawn-requester",
        sessionId: "recovered-parent-session",
        parentSessionKey: null,
        scopes: ["operator.write"],
        sourceIngress: "internal",
      });
      await commitMainSessionRecovery({
        target: fixture.target,
        command: { kind: "mark_interrupted", cycleId: "recovery-spawn", now: 1 },
      });
      const observed = await commitMainSessionRecovery({
        target: fixture.target,
        command: {
          kind: "inspect",
          sessionKey: fixture.target.sessionKey,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
      });
      if (
        observed.transition.kind !== "observed" ||
        observed.transition.view.status !== "recoverable"
      ) {
        throw new Error(`Expected recoverable requester: ${JSON.stringify(observed.transition)}`);
      }
      await commitMainSessionRecovery({
        target: fixture.target,
        command: {
          kind: "prepare_attempt",
          observation: observed.transition.view.observation,
          attempt: observed.transition.view.nextAttempt,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          now: 1,
          runId: fixture.target.recoveryRunId,
          executionIdentity: { state: "disabled" },
        },
      });
      const childStarted = createDeferred();
      const finishChild = createDeferred();
      const childFinished = createDeferred();
      void childFinished.promise.catch(() => {});
      const childTerminal = createDeferred();
      let childRunId: string | undefined;
      let childSessionKey: string | undefined;
      const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
        // Stop may retire the registry row after publishing its terminal outcome.
        if (
          childRunId &&
          resolveSubagentSessionStatus(subagentRuns.get(childRunId)) ===
            (outcome === "stop" ? "killed" : "done")
        ) {
          childTerminal.resolve();
        }
      });
      const failures: unknown[] = [];
      runEmbeddedAgent.mockImplementation(async (params) => {
        const admitted = await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          admittedRunContext: params.admittedRunContext,
          preparedRunAdmission: params.preparedRunAdmission,
        });
        await params.onExecutionStarted?.();
        if (params.sessionKey === fixture.target.sessionKey) {
          const spawn = createSessionsSpawnTool({
            config: bound.cfg,
            expectedParentSessionId: fixture.target.sessionId,
            agentSessionKey: fixture.target.sessionKey,
            requesterRunId: params.runId,
            requesterTurnRunId: params.runId,
          });
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: fixture.target.agentId,
            sessionKey: fixture.target.sessionKey,
          });
          const spawned = await withPluginRuntimeGatewayRequestScope(
            { context, isWebchatConnect: () => false },
            () =>
              withGatewayToolCallerIdentity(caller, () =>
                spawn.execute!("recovery-spawn", { task: "bounded child" }),
              ),
          );
          const accepted = expectDefined(
            normalizeAcceptedSessionSpawnResult(spawned),
            "recovered requester child",
          );
          childRunId = accepted.runId;
          childSessionKey = accepted.childSessionKey;
          await childStarted.promise;
        } else {
          const signal = expectDefined(params.abortSignal, "child cancellation signal");
          const onAbort = () => finishChild.resolve();
          signal.addEventListener("abort", onAbort, { once: true });
          childStarted.resolve();
          try {
            await finishChild.promise;
            signal.throwIfAborted();
            expect(readAdmittedRunOperatorAuthority(admitted)).toMatchObject({
              profileId: profile.id,
              scopes: ["operator.write"],
            });
            expectDefined(resolveAdmittedRunActiveAssertion(admitted), "child authority")();
          } catch (error) {
            childFinished.reject(error);
            throw error;
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        }
        await recordSpawnBoundaryFinal({
          storePath: bound.storePath,
          sessionKey: expectDefined(params.sessionKey, "admitted session"),
          runId: params.runId,
          text: "Recovered task complete.",
        });
        if (params.sessionKey !== fixture.target.sessionKey) {
          childFinished.resolve();
        }
        return {
          payloads: [{ text: "Recovered task complete." }],
          meta: {
            durationMs: 1,
            terminalReply: { disposition: "visible", text: "Recovered task complete." },
          },
        };
      });
      try {
        await expect(
          runtime.recovery.dispatchAgent(
            {
              message: "Resume the interrupted operator task and delegate its remaining work.",
              agentId: fixture.target.agentId,
              sessionKey: fixture.target.sessionKey,
              expectedExistingSessionId: fixture.target.sessionId,
              idempotencyKey: fixture.target.recoveryRunId,
            },
            undefined,
            { restartRecoveryOperatorTarget: fixture.target, expectFinal: true },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        expect(getRpcSource(fixture.target.recoveryRunId)).toBeUndefined();
        expect(
          peekSystemEventEntries("agent:main:main").filter((event) =>
            event.contextKey?.startsWith("session-state:"),
          ),
        ).toEqual([]);
        const acceptedRunId = expectDefined(childRunId, "accepted child run");
        const acceptedSessionKey = expectDefined(childSessionKey, "accepted child session");
        expect(resolveSubagentSessionStatus(subagentRuns.get(acceptedRunId))).toBe("running");
        if (outcome === "stop") {
          const stopped = await withPluginRuntimeGatewayRequestScope(
            { context, client: fixture.client, isWebchatConnect: () => false },
            () =>
              dispatchGatewayMethodInProcess(
                "sessions.abort",
                { key: fixture.target.sessionKey },
                { resolveGatewayContext: bound.resolveGatewayContext },
              ),
          );
          expect(stopped).toMatchObject({ ok: true, status: "aborted" });
        } else {
          finishChild.resolve();
          await withinTest(childFinished.promise, testSignal);
        }
        await withinTest(childTerminal.promise, testSignal);
        await settleRootWork(true);
        expect(
          loadSessionEntry({ storePath: bound.storePath, sessionKey: acceptedSessionKey }),
        ).toMatchObject({ status: outcome === "stop" ? "killed" : "done" });
      } catch (error) {
        failures.push(error);
      } finally {
        unsubscribe();
        finishChild.resolve();
        failures.push(...(await closeBoundGateway(bound, runtime, childRunId)));
        throwBoundFailures(failures);
      }
    },
  );
}
