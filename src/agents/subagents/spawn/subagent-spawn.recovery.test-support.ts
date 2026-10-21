import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { createOperatorRecoveryFixture } from "../../../gateway/operator-run-recovery.test-support.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { bindSessionRowProjection } from "../../../gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../../gateway/session-row-projection.js";
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
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
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
  it.for([
    { outcome: "complete", child: "spawned" },
    { outcome: "stop", child: "spawned" },
    { outcome: "complete", child: "resumed" },
  ] as const)(
    "lets a recovered requester finish before its $child child: $outcome",
    async ({ outcome, child }, { signal: testSignal }) => {
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
      if (child === "resumed") {
        childSessionKey = "agent:main:subagent:interrupted-child";
        await replaceSessionEntry(
          { storePath: bound.storePath, sessionKey: childSessionKey },
          {
            sessionId: "interrupted-child-session",
            lifecycleRevision: "interrupted-child-lifecycle",
            updatedAt: 1,
            status: "interrupted",
            spawnedBy: fixture.target.sessionKey,
            parentSessionId: fixture.target.sessionId,
            createdActor: fixture.entry.createdActor,
            spawnDepth: 1,
          },
        );
        const projection = await createSessionRowProjection({ cfg: bound.cfg, modelCatalog: [] });
        onTestFinished(async () => {
          projection.dispose();
          await projection.ensureMaterialized();
        });
        bindSessionRowProjection(context, () => projection);
        await projection.ensureMaterialized();
      }
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
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: fixture.target.agentId,
            sessionKey: fixture.target.sessionKey,
          });
          const spawned = await withPluginRuntimeGatewayRequestScope(
            { context, isWebchatConnect: () => false },
            () =>
              withGatewayToolCallerIdentity(caller, () => {
                if (child === "resumed") {
                  return createSessionsSendTool({
                    config: bound.cfg,
                    agentSessionKey: fixture.target.sessionKey,
                    agentSessionId: fixture.target.sessionId,
                    requesterTurnRunId: params.runId,
                  }).execute!("recovery-resume", {
                    sessionKey: childSessionKey,
                    message: "Continue the interrupted child task.",
                    mode: "followup",
                    timeoutSeconds: 0,
                  });
                }
                return createSessionsSpawnTool({
                  config: bound.cfg,
                  expectedParentSessionId: fixture.target.sessionId,
                  agentSessionKey: fixture.target.sessionKey,
                  requesterRunId: params.runId,
                  requesterTurnRunId: params.runId,
                }).execute!("recovery-spawn", { task: "bounded child" });
              }),
          );
          if (child === "resumed") {
            expect(spawned.details, JSON.stringify(spawned.details)).toMatchObject({
              status: "accepted",
            });
          } else {
            const accepted = expectDefined(
              normalizeAcceptedSessionSpawnResult(spawned),
              "recovered requester child",
            );
            childRunId = accepted.runId;
            childSessionKey = accepted.childSessionKey;
          }
          await childStarted.promise;
        } else {
          childRunId = params.runId;
          if (child === "resumed") {
            expect(params.prompt).toContain("Your previous turn was interrupted");
            expect(params.lane).toBe(`nested:${childSessionKey}`);
          }
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
