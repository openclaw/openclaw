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
import { drainFormattedSystemEvents } from "../../../auto-reply/reply/session-system-events.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  canRequesterAbortChatRun,
  resolveChatAbortRequester,
} from "../../../gateway/server-methods/chat-abort-authorization.js";
import { handleChatAbortRequestWithLifecycle } from "../../../gateway/server-methods/chat-abort-handler.js";
import { requireLastRespondCall } from "../../../gateway/server-methods/chat.abort-authorization.test-helpers.js";
import { invokeChatAbortHandler } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  captureExecRequestOwners,
  readExecRequestOwners,
  withExecRequestOwners,
  withExecRequestTurn,
} from "../../../infra/exec-request-context.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
} from "../../../infra/system-events.js";
import { getProcessSupervisor } from "../../../process/supervisor/index.js";
import { getRpcSource } from "../../../sessions/session-controller.rpc-sources.js";
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
import { prepareSubagentRunsByRunIds } from "../registry/subagent-registry.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  collectFailure,
  sessionReader,
  visibleResult,
} from "./subagent-spawn.fixtures.test-support.js";
import {
  createBoundSpawnInvocation,
  recordSpawnBoundaryFinal,
  type RequestCustodySpawnCaseOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<RequestCustodySpawnCaseOptions["createBoundParent"]>>;

export async function retainOriginalRequest(
  bound: BoundParent,
  runId: string,
  sessionId: string,
  text: string,
  lifecycleRevision?: string,
) {
  const original = {
    runId,
    sessionId,
    sessionKey: "agent:main:main",
    agentId: "main",
    ownerConnId: "request-owner",
  };
  await replaceSessionEntry(
    { storePath: bound.storePath, sessionKey: original.sessionKey },
    {
      sessionId: original.sessionId,
      updatedAt: Date.now(),
      ...(lifecycleRevision ? { lifecycleRevision } : {}),
    },
  );
  const owners = await withExecRequestTurn({ identity: original }, async () =>
    expectDefined(captureExecRequestOwners(original), "original request owners"),
  );
  const event = expectDefined(
    enqueueSystemEventEntry(
      text,
      withExecRequestOwners({ sessionKey: original.sessionKey }, owners),
    ),
    "original queued occurrence",
  );
  return { original, owners, event };
}

export function createCustodyStop(
  bound: BoundParent,
  original: Awaited<ReturnType<typeof retainOriginalRequest>>["original"],
) {
  return (connId: string, exact: boolean) =>
    invokeChatAbortHandler({
      handler: (request) =>
        handleChatAbortRequestWithLifecycle(request, { cascadeDescendants: true }),
      context: bound.context,
      request: {
        sessionKey: original.sessionKey,
        agentId: original.agentId,
        ...(exact ? { runId: original.runId } : {}),
      },
      client: { connId, connect: { scopes: ["operator.write"] } },
    });
}

const watchedCommand = `node -e "require('fs').watch('.', () => {})"`;
const foregroundCommand = () => ({ command: watchedCommand, yieldMs: 10, timeoutSeconds: 60 });
function commandTool(params: Parameters<typeof createLazyExecTool>[0]) {
  return createLazyExecTool({
    host: "gateway",
    mode: "full",
    ask: "off",
    allowBackground: true,
    notifyOnExit: false,
    preparedStoreEnvironment: {},
    ...params,
  });
}
function commandSession(result: { details?: unknown }, label: string) {
  const details = asOptionalRecord(result.details);
  if (typeof details?.sessionId !== "string") {
    throw new Error(`Expected ${label}'s process handle`);
  }
  return expectDefined(getSession(details.sessionId), label);
}
function completionReceipt({ execution, completion, endedReason }: SubagentRunRecord) {
  return { execution, completion, endedReason };
}

export function registerCompletedRequestCustodySpawnCases(options: RequestCustodySpawnCaseOptions) {
  const { parentSessionKey, parentRunId } = options;
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
      const bound = await options.createBoundParent();
      const { runtime } = await options.createBoundGateway(bound);
      const readSession = sessionReader(bound.storePath);
      const { original, owners, event } = await retainOriginalRequest(
        bound,
        "completed-child-original-request",
        "completed-child-original-session",
        "Exec completed (original-command, code 0) :: Finish original request",
        "original-request-generation",
      );
      const originalTarget = {
        agentId: original.agentId,
        sessionKey: original.sessionKey,
        sessionId: original.sessionId,
      };
      const telegramContext = {
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:request-owner",
        To: "telegram:request-owner",
        SessionKey: original.sessionKey,
      };
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
          const exec = commandTool({
            runId: run.runId,
            sessionKey,
            sessionId: run.sessionId,
            agentId: run.agentId,
            config: run.config,
            cwd: input.workspaceDir,
            scopeKey: sessionKey,
          });
          const result = await withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
            exec.execute("completed-routed-child-command", foregroundCommand(), run.abortSignal),
          );
          expect(asOptionalRecord(result.details)?.status).toBe("running");
          command = commandSession(result, "real child command");
          expect(readExecRequestOwners(command)).toEqual(requestOwners);
          if (mode !== "retained-exact") {
            const service = await exec.execute(
              "independent-routed-child-service",
              { command: watchedCommand, background: true, timeoutSeconds: 60 },
              run.abortSignal,
            );
            independent = commandSession(service, "independent service");
            expect(readExecRequestOwners(independent)).toBeUndefined();
          }
          commandReady.resolve(command);
          await completeModel.promise;
          await recordSpawnBoundaryFinal({
            storePath: bound.storePath,
            sessionKey,
            runId: run.runId,
            text: "Completed child result",
          });
          return visibleResult("Completed child result");
        });
      options.runEmbeddedAgent.mockImplementationOnce((params) => {
        const result = native.runEmbeddedAgent(params);
        void result.catch(commandReady.reject);
        return result;
      });
      const failures: unknown[] = [];
      await collectFailure(failures, async () => {
        const invoke = await withExecRequestTurn(
          {
            identity: parentRequestIdentity(parentRunId, parentSessionKey),
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
        let receipt: ReturnType<typeof completionReceipt> | undefined;
        if (mode === "consumed-active-revoked") {
          expect(subagentRuns.get(childRunId)?.execution.endedAt).toBeUndefined();
        } else {
          completeModel.resolve();
          inspectTerminal();
          const completed = await withinTest(terminal.promise, signal);
          receipt = structuredClone(completionReceipt(completed));
          expect(completed).toMatchObject({
            execution: { outcome: { status: "ok" } },
            completion: { resultText: "Completed child result" },
          });
        }
        expect(runningCommand.exited).toBe(false);
        bound.admission.close();
        bound.parent.cleanup();
        expect(captureExecRequestCancellation(original).owners).toEqual(owners);
        const stop = createCustodyStop(bound, original);
        if (mode !== "retained-exact") {
          // Retire the occurrence through prompt adoption, bypassed by this parent fixture.
          const admittedContext = await drainFormattedSystemEvents({
            cfg: bound.cfg,
            agentId: original.agentId,
            sessionKey: original.sessionKey,
            isMainSession: true,
            isNewSession: false,
            events: [event],
          });
          expect(admittedContext).toContain(event.text);
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
              const result = await commandTool({
                ...laterIdentity,
                config: bound.cfg,
                cwd: expectDefined(bound.cfg.agents?.defaults?.workspace, "fixture workspace"),
                scopeKey: parentSessionKey,
              }).execute("later-human-command", foregroundCommand());
              return commandSession(result, "later human command");
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
              admittedTarget: originalTarget,
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
                ...originalTarget,
                storePath: bound.storePath,
                lifecycleRevision: "original-request-generation",
              },
              acceptsRequest: (identity) =>
                canRequesterAbortChatRun(
                  {
                    ...identity,
                    requester: {
                      connectionId: identity.ownerConnId,
                      deviceId: identity.ownerDeviceId,
                    },
                  },
                  requester,
                ),
            },
          });
          const active = expectDefined(getRpcSource(childRunId), "active native child");
          active.input.abortSignal.addEventListener(
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
          const entry = expectDefined(readSession(original.sessionKey), "original session");
          const cfg = {
            ...bound.cfg,
            commands: { ...bound.cfg.commands, text: true, allowFrom: { "*": ["*"] } },
          };
          const params = buildCommandTestParams("/stop", cfg, {
            ...telegramContext,
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
          expect(readSession(original.sessionKey)).toMatchObject({
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
              ...telegramContext,
              AgentId: original.agentId,
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
        const prepared = await prepareSubagentRunsByRunIds([accepted.runId]);
        const selected = prepared.consume((runs) => runs.get(accepted.runId));
        if (!selected.ready) {
          throw new Error("Native child changed while reading its retained receipt");
        }
        const after = expectDefined(selected.value, "native child after Stop");
        if (mode === "consumed-active-revoked") {
          expect(after).toMatchObject({
            execution: { status: "terminal" },
            endedReason: "subagent-killed",
            killReconciliation: { taskCancellationAccepted: true },
          });
        } else {
          expect(completionReceipt(after)).toEqual(receipt);
          expect(after.killReconciliation).toBeUndefined();
        }
        expect(after.killIntent).toBeUndefined();
        if (mode !== "retained-exact") {
          expect(independent?.exited).toBe(false);
          expect(laterHuman?.exited).toBe(false);
        }
      });
      completeModel.resolve();
      releaseCleanup.resolve();
      restorePreparation?.();
      stopObserving();
      consumeSelectedSystemEventEntries(original.sessionKey, [event]);
      for (const ownedProcess of [command, independent, laterHuman]) {
        if (!ownedProcess) {
          continue;
        }
        await collectFailure(failures, async () => {
          getProcessSupervisor().cancel(ownedProcess.id, "manual-cancel");
          await waitForExecSession(ownedProcess);
          deleteSession(ownedProcess.id);
        });
      }
      await activeStop?.catch((error: unknown) => {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      });
      if (childSessionKey) {
        const target = { cfg: bound.cfg, sessionKey: childSessionKey };
        await collectFailure(failures, () => killSubagentRunAdmin(target));
      }
      failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
      model.mockRestore();
      restoreProcess?.();
      options.throwBoundFailures(failures);
    },
  );
}

export function parentRequestIdentity(runId: string, sessionKey: string) {
  return { runId, sessionKey, sessionId: "parent-session", agentId: "main" };
}
