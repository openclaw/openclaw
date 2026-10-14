import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { tryFastAbortFromMessage } from "../../../auto-reply/reply/abort.js";
import { handleStopCommand } from "../../../auto-reply/reply/commands-session-abort.js";
import { buildCommandTestParams } from "../../../auto-reply/reply/commands.test-harness.js";
import {
  recordReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "../../../auto-reply/reply/reply-operation-run-state.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  canRequesterAbortChatRun,
  resolveChatAbortRequester,
} from "../../../gateway/server-methods/chat-abort-authorization.js";
import { handleChatAbortRequestWithLifecycle } from "../../../gateway/server-methods/chat-abort-handler.js";
import { requireLastRespondCall } from "../../../gateway/server-methods/chat.abort-authorization.test-helpers.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  captureExecRequestOwners,
  readExecRequestOwners,
  withExecRequestOwners,
  withExecRequestTurn,
} from "../../../infra/exec-request-context.js";
import { createHeartbeatDispatch } from "../../../infra/heartbeat-dispatch.js";
import {
  prepareHeartbeatRunStage,
  resolveHeartbeatWakeStage,
  type HeartbeatRunOptions,
} from "../../../infra/heartbeat-runner-execution.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
} from "../../../infra/system-events.js";
import { getProcessSupervisor } from "../../../process/supervisor/index.js";
import { isPidDefinitelyDead } from "../../../shared/pid-alive.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import { captureExecRequestCancellation } from "../../bash-process-control.js";
import {
  deleteSession,
  getSession,
  waitForExecSession,
  type ProcessSession,
} from "../../bash-process-registry.js";
import { createLazyExecTool } from "../../lazy-exec-tool.js";
import {
  killAllControlledSubagentRuns,
  killSubagentRunAdmin,
} from "../registry/subagent-control-kill.js";
import {
  captureExecRequestSubagentSelection,
  resolveSubagentController,
} from "../registry/subagent-control-scope.js";
import * as nativeSession from "../registry/subagent-control-session.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  createBoundSpawnInvocation,
  type RequestCustodySpawnCaseOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerCompletedRequestCustodySpawnCases(options: RequestCustodySpawnCaseOptions) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    throwBoundFailures,
    parentSessionKey,
    parentRunId,
  } = options;
  it.for([
    "retained-exact",
    "consumed-session",
    "consumed-channel",
    "consumed-command-handler",
    "consumed-generation-replaced",
    "consumed-active-revoked",
  ] as const)(
    "preserves routed native Stop authority and existing receipts (%s)",
    async (mode, { signal }) => {
      const bound = await createBoundParent();
      const { runtime } = await createBoundGateway(bound);
      const original = {
        runId: "completed-child-original-request",
        sessionKey: "agent:main:main",
        sessionId: "completed-child-original-session",
        agentId: "main",
        ownerConnId: "request-owner",
      };
      await replaceSessionEntry(
        { storePath: bound.storePath, sessionKey: original.sessionKey },
        {
          sessionId: original.sessionId,
          lifecycleRevision: "original-request-generation",
          updatedAt: Date.now(),
        },
      );
      const owners = await withExecRequestTurn({ identity: original }, async () =>
        expectDefined(captureExecRequestOwners(original), "original request owners"),
      );
      const event = expectDefined(
        enqueueSystemEventEntry(
          "Exec completed (original-command, code 0) :: Finish original request",
          withExecRequestOwners({ sessionKey: original.sessionKey }, owners),
        ),
        "original queued occurrence",
      );
      const commandReady = createDeferred<ProcessSession>();
      void commandReady.promise.catch(() => undefined);
      const completeModel = createDeferred();
      const cleanupEntered = createDeferred();
      const releaseCleanup = createDeferred();
      const terminal = createDeferred<SubagentRunRecord>();
      let childRunId: string | undefined;
      let childSessionKey: string | undefined;
      let command: ProcessSession | undefined;
      let independent: ProcessSession | undefined;
      let laterHuman: ProcessSession | undefined;
      let restorePreparation: (() => void) | undefined;
      let restoreProcess: (() => void) | undefined;
      let activeStop: ReturnType<typeof killAllControlledSubagentRuns> | undefined;
      if (mode === "consumed-active-revoked") {
        const supervisor = getProcessSupervisor();
        const spawn = supervisor.spawn.bind(supervisor);
        let retained = false;
        const processObservation = vi
          .spyOn(supervisor, "spawn")
          .mockImplementation(async (input) => {
            const managed = await spawn(input);
            if (retained) {
              return managed;
            }
            retained = true;
            return {
              ...managed,
              waitForExtinction: async () => {
                await managed.wait();
                const outcome = await managed.waitForExtinction?.();
                cleanupEntered.resolve();
                await releaseCleanup.promise;
                return outcome;
              },
            };
          });
        restoreProcess = () => processObservation.mockRestore();
      }
      const inspectTerminal = () => {
        const current = childRunId ? subagentRuns.get(childRunId) : undefined;
        if (current?.execution.status === "terminal") {
          terminal.resolve(current);
        }
      };
      const stopObserving = subscribeSubagentRunChanges("persistence", inspectTerminal);
      const loop = await import("../../embedded-agent-runner/run-loop.js");
      const native = await import("../../embedded-agent-runner/run-orchestrator.js");
      const model = vi
        .spyOn(loop, "runPreparedEmbeddedLoop")
        .mockImplementationOnce(async (_refresh, input) => {
          const run = input.runParams;
          const sessionKey = expectDefined(run.sessionKey, "child run session key");
          const requestOwners = expectDefined(
            captureExecRequestOwners(run),
            "real child request custody",
          );
          expect(requestOwners.map((owner) => owner.identity)).toEqual([
            expect.objectContaining({ runId: run.runId, sessionId: run.sessionId, sessionKey }),
          ]);
          const exec = createLazyExecTool({
            runId: run.runId,
            sessionKey,
            sessionId: run.sessionId,
            agentId: run.agentId,
            config: run.config,
            cwd: input.workspaceDir,
            scopeKey: sessionKey,
            host: "gateway",
            mode: "full",
            ask: "off",
            allowBackground: true,
            notifyOnExit: false,
            preparedStoreEnvironment: {},
          });
          const result = await withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
            exec.execute(
              "completed-routed-child-command",
              {
                command: `node -e "require('fs').watch('.', () => {})"`,
                yieldMs: 10,
                timeoutSeconds: 60,
              },
              run.abortSignal,
            ),
          );
          const details = asOptionalRecord(result.details);
          expect(details?.status).toBe("running");
          if (typeof details?.sessionId !== "string") {
            throw new Error("Expected the child's running command handle");
          }
          command = expectDefined(getSession(details.sessionId), "real child command");
          expect(readExecRequestOwners(command)).toEqual(requestOwners);
          if (mode !== "retained-exact") {
            const service = await exec.execute(
              "independent-routed-child-service",
              {
                command: `node -e "require('fs').watch('.', () => {})"`,
                background: true,
                timeoutSeconds: 60,
              },
              run.abortSignal,
            );
            const serviceDetails = asOptionalRecord(service.details);
            if (typeof serviceDetails?.sessionId !== "string") {
              throw new Error("Expected the independent service's process handle");
            }
            independent = expectDefined(
              getSession(serviceDetails.sessionId),
              "independent service",
            );
            expect(readExecRequestOwners(independent)).toBeUndefined();
          }
          commandReady.resolve(command);
          await completeModel.promise;
          return {
            payloads: [{ text: "Completed child result" }],
            meta: {
              durationMs: 1,
              finalAssistantVisibleText: "Completed child result",
              finalAssistantRawText: "Completed child result",
            },
          };
        });
      options.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        try {
          return await native.runEmbeddedAgent(params);
        } catch (error) {
          commandReady.reject(error);
          throw error;
        }
      });
      const failures: unknown[] = [];
      try {
        const invoke = await withExecRequestTurn(
          {
            identity: {
              runId: parentRunId,
              sessionKey: parentSessionKey,
              sessionId: "parent-session",
              agentId: "main",
            },
            owners,
          },
          async () =>
            createBoundSpawnInvocation(bound, {
              context: "isolated",
              cleanup: "keep",
              expectsCompletionMessage: false,
            }),
        );
        const accepted = expectDefined(
          normalizeAcceptedSessionSpawnResult(await invoke()),
          "accepted native child",
        );
        childRunId = accepted.runId;
        childSessionKey = accepted.childSessionKey;
        const runningCommand = await withinTest(commandReady.promise, signal);
        let receipt:
          | Pick<SubagentRunRecord, "execution" | "completion" | "endedReason">
          | undefined;
        if (mode === "consumed-active-revoked") {
          expect(subagentRuns.get(childRunId)?.execution.endedAt).toBeUndefined();
        } else {
          completeModel.resolve();
          inspectTerminal();
          const completed = await withinTest(terminal.promise, signal);
          receipt = structuredClone({
            execution: completed.execution,
            completion: completed.completion,
            endedReason: completed.endedReason,
          });
          expect(completed.execution.outcome).toMatchObject({ status: "ok" });
          expect(completed.completion?.resultText).toBe("Completed child result");
        }
        expect(model).toHaveBeenCalledOnce();
        expect(runningCommand.exited).toBe(false);
        bound.admission.close();
        bound.parent.cleanup();
        expect(captureExecRequestCancellation(original).owners).toEqual(owners);
        const context = createChatAbortContext({ getRuntimeConfig: () => bound.cfg });
        const stop = (connId: string, exact: boolean) =>
          invokeChatAbortHandler({
            handler: (request) =>
              handleChatAbortRequestWithLifecycle(request, { cascadeDescendants: true }),
            context,
            request: {
              sessionKey: original.sessionKey,
              agentId: original.agentId,
              ...(exact ? { runId: original.runId } : {}),
            },
            client: { connId, connect: { scopes: ["operator.write"] } },
          });
        if (mode !== "retained-exact") {
          // The bound native-parent fixture replaces model admission. Use the real
          // heartbeat preparation and acknowledgement owner to retire its event.
          const heartbeatOptions: HeartbeatRunOptions = {
            cfg: bound.cfg,
            agentId: original.agentId,
            sessionKey: original.sessionKey,
            source: "exec-event",
            intent: "event",
            reason: "exec-event",
            heartbeat: { every: "1h", target: "none", isolatedSession: false },
          };
          const wake = await resolveHeartbeatWakeStage(heartbeatOptions);
          if (wake.kind !== "ready") {
            throw new Error(`Heartbeat acknowledgement preparation skipped: ${wake.reason}`);
          }
          const prepared = await prepareHeartbeatRunStage(wake);
          if (prepared.kind !== "ready") {
            throw new Error(`Heartbeat acknowledgement routing skipped: ${prepared.reason}`);
          }
          expect(prepared.inspectedSystemEventsToConsume.map((selected) => selected.id)).toContain(
            event.id,
          );
          const replyState: ReplyOperationRunState = {};
          recordReplyOperationAgentTurn([replyState], undefined, {
            kind: "settled",
            status: "ok",
            result: { acceptedSessionSpawns: [accepted] },
          });
          const acknowledgement = createHeartbeatDispatch(heartbeatOptions, wake, prepared);
          await acknowledgement.prepareReply({ text: "HEARTBEAT_OK" }, replyState);
          expect(acknowledgement.result).toMatchObject({ status: "ran" });
          expect(
            peekSystemEventEntries(original.sessionKey).map((selected) => selected.id),
          ).not.toContain(event.id);
          expect(captureExecRequestCancellation(original).owners).toEqual([]);
          const historical = requireLastRespondCall(await stop(original.ownerConnId, true));
          expect(historical.slice(0, 2)).toEqual([true, { ok: true, aborted: false, runIds: [] }]);
          expect(runningCommand.exited).toBe(false);
          const laterIdentity = {
            runId: "later-routed-human",
            sessionKey: parentSessionKey,
            sessionId: "parent-session",
            agentId: "main",
            ownerConnId: "later-human",
          };
          laterHuman = await withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
            withExecRequestTurn({ identity: laterIdentity }, async () => {
              const result = await createLazyExecTool({
                ...laterIdentity,
                config: bound.cfg,
                cwd: expectDefined(bound.cfg.agents?.defaults?.workspace, "fixture workspace"),
                scopeKey: parentSessionKey,
                host: "gateway",
                mode: "full",
                ask: "off",
                allowBackground: true,
                notifyOnExit: false,
                preparedStoreEnvironment: {},
              }).execute("later-human-command", {
                command: `node -e "require('fs').watch('.', () => {})"`,
                yieldMs: 10,
                timeoutSeconds: 60,
              });
              const details = asOptionalRecord(result.details);
              if (typeof details?.sessionId !== "string") {
                throw new Error("Expected the later human command's process handle");
              }
              return expectDefined(getSession(details.sessionId), "later human command");
            }),
          );
          const foreign = requireLastRespondCall(await stop("another-owner", false));
          expect(foreign.slice(0, 2)).toEqual([true, { ok: true, aborted: false, runIds: [] }]);
          expect(runningCommand.exited).toBe(false);
        }
        if (mode === "consumed-active-revoked") {
          const source = new AbortController();
          const assertCurrent = () => source.signal.throwIfAborted();
          const requester = resolveChatAbortRequester(
            createSyntheticPluginRuntimeClient({
              scopes: ["operator.sessions.write"],
              agentToolCaller: {
                agentId: original.agentId,
                sessionKey: original.sessionKey,
                assertCurrent,
              },
            }),
            {
              admittedTarget: {
                agentId: original.agentId,
                sessionKey: original.sessionKey,
                sessionId: original.sessionId,
              },
              assertCurrent,
              assertTargetCurrent: assertCurrent,
            },
          );
          const authority = expectDefined(requester.sessionAuthority, "narrow requester authority");
          const controller = resolveSubagentController({
            cfg: bound.cfg,
            agentSessionKey: original.sessionKey,
            agentId: original.agentId,
          });
          const requestSelection = captureExecRequestSubagentSelection({
            cfg: bound.cfg,
            controller,
            owners: captureExecRequestCancellation(original).owners,
            sessionOrigin: {
              target: {
                agentId: original.agentId,
                sessionKey: original.sessionKey,
                sessionId: original.sessionId,
                storePath: bound.storePath,
                lifecycleRevision: "original-request-generation",
              },
              acceptsRequest: (identity) => canRequesterAbortChatRun(identity, requester),
            },
          });
          expect(requestSelection.runs.map((entry) => entry.runId)).toEqual([childRunId]);
          const active = expectDefined(
            bound.context.chatAbortControllers.get(childRunId),
            "active native child",
          );
          active.controller.signal.addEventListener(
            "abort",
            () => {
              source.abort(new Error("Requester revoked after native acceptance"));
              completeModel.resolve();
            },
            { once: true },
          );
          activeStop = killAllControlledSubagentRuns({
            cfg: bound.cfg,
            controller,
            runs: requestSelection.runs,
            requestSelection,
            assertCurrent: authority.assertCurrent,
            suppressTaskDelivery: true,
          });
          await withinTest(
            awaitGateBeforeSettlement(
              cleanupEntered.promise,
              activeStop,
              "Native Stop returned before accepted command cleanup",
            ),
            signal,
          );
          expect(source.signal.aborted).toBe(true);
          expect(subagentRuns.get(childRunId)?.killIntent).toBeDefined();
          releaseCleanup.resolve();
          const stopped = await withinTest(activeStop, signal);
          expect(stopped).toMatchObject({
            status: "error",
            killed: 1,
            error: expect.stringContaining("Requester revoked after native acceptance"),
          });
        } else if (mode === "consumed-generation-replaced") {
          const prepare = nativeSession.prepareSubagentKillSession;
          let replaced = false;
          const preparation = vi
            .spyOn(nativeSession, "prepareSubagentKillSession")
            .mockImplementation(async (...args) => {
              const session = await prepare(...args);
              if (!replaced && args[1] === childSessionKey) {
                try {
                  await replaceSessionEntry(
                    { storePath: bound.storePath, sessionKey: original.sessionKey },
                    {
                      sessionId: original.sessionId,
                      lifecycleRevision: "replacement-request-generation",
                      updatedAt: Date.now(),
                    },
                  );
                  replaced = true;
                } catch (error) {
                  await session.release();
                  throw error;
                }
              }
              return session;
            });
          restorePreparation = () => preparation.mockRestore();
          await expect(stop(original.ownerConnId, false)).rejects.toThrow(
            /original session generation/,
          );
          expect(replaced).toBe(true);
          expect(runningCommand.exited).toBe(false);
          expect(owners.every((owner) => !owner.signal.aborted)).toBe(true);
        } else if (mode === "consumed-command-handler") {
          const entry = expectDefined(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: original.sessionKey }),
            "original session",
          );
          const cfg = {
            ...bound.cfg,
            commands: { ...bound.cfg.commands, text: true, allowFrom: { "*": ["*"] } },
          };
          const params = buildCommandTestParams("/stop", cfg, {
            Provider: "telegram",
            Surface: "telegram",
            From: "telegram:request-owner",
            To: "telegram:request-owner",
            SessionKey: original.sessionKey,
            CommandTargetSessionKey: original.sessionKey,
          });
          const stopped = await handleStopCommand(
            {
              ...params,
              sessionKey: original.sessionKey,
              sessionEntry: entry,
              sessionStore: { [original.sessionKey]: entry },
              storePath: bound.storePath,
            },
            true,
          );
          expect(stopped).toMatchObject({
            shouldContinue: false,
            reply: { text: "⚙️ Agent was aborted." },
          });
          expect(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: original.sessionKey }),
          ).toMatchObject({
            abortedLastRun: true,
            sessionId: original.sessionId,
            lifecycleRevision: "original-request-generation",
          });
        } else if (mode === "consumed-channel") {
          const stopped = await tryFastAbortFromMessage({
            cfg: bound.cfg,
            ctx: buildTestCtx({
              CommandBody: "/stop",
              RawBody: "/stop",
              CommandAuthorized: true,
              Provider: "telegram",
              Surface: "telegram",
              SessionKey: original.sessionKey,
              AgentId: original.agentId,
              From: "telegram:request-owner",
              To: "telegram:request-owner",
            }),
          });
          expect(stopped).toMatchObject({
            handled: true,
            aborted: true,
            stoppedSubagents: 0,
            failedSubagents: 0,
          });
        } else {
          const stopped = requireLastRespondCall(
            await stop(original.ownerConnId, mode === "retained-exact"),
          );
          expect(stopped.slice(0, 2)).toEqual([true, { ok: true, aborted: true, runIds: [] }]);
        }
        if (mode !== "consumed-generation-replaced") {
          expect(runningCommand).toMatchObject({ exited: true, exitReason: "manual-cancel" });
          expect(isPidDefinitelyDead(expectDefined(runningCommand.pid, "child command pid"))).toBe(
            true,
          );
        }
        const after = expectDefined(subagentRuns.get(childRunId), "native child after Stop");
        if (mode === "consumed-active-revoked") {
          expect(after).toMatchObject({
            execution: { status: "terminal" },
            endedReason: "subagent-killed",
            killReconciliation: { taskCancellationAccepted: true },
          });
        } else {
          expect({
            execution: after.execution,
            completion: after.completion,
            endedReason: after.endedReason,
          }).toEqual(receipt);
          expect(after.killReconciliation).toBeUndefined();
        }
        expect(after.killIntent).toBeUndefined();
        if (mode !== "retained-exact") {
          expect(independent?.exited).toBe(false);
          expect(laterHuman?.exited).toBe(false);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        completeModel.resolve();
        releaseCleanup.resolve();
        restorePreparation?.();
        stopObserving();
        consumeSelectedSystemEventEntries(original.sessionKey, [event]);
        for (const ownedProcess of [command, independent, laterHuman]) {
          if (!ownedProcess) {
            continue;
          }
          try {
            getProcessSupervisor().cancel(ownedProcess.id, "manual-cancel");
            await waitForExecSession(ownedProcess);
            deleteSession(ownedProcess.id);
          } catch (error) {
            failures.push(error);
          }
        }
        await activeStop?.catch((error: unknown) => {
          if (!failures.includes(error)) {
            failures.push(error);
          }
        });
        if (childSessionKey) {
          try {
            await killSubagentRunAdmin({ cfg: bound.cfg, sessionKey: childSessionKey });
          } catch (error) {
            failures.push(error);
          }
        }
        failures.push(...(await closeBoundGateway(bound, runtime, childRunId)));
        model.mockRestore();
        restoreProcess?.();
        throwBoundFailures(failures);
      }
    },
  );
}
