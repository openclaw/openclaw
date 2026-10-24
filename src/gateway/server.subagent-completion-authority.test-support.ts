import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../agents/announce-idempotency.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { AssistantMessage } from "../llm/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { tryBeginGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";

/** Real registered runs share a child session but retain independent completion sources. */
export async function createRegisteredCompletionPair(context: GatewayRequestContext) {
  const id = randomUUID();
  async function createSession(kind: "requester" | "child", spawnedBy?: string) {
    const sessionKey = `agent:main:${kind === "child" ? "dashboard:" : ""}completion-pair:${id}`;
    const target = { agentId: "main", sessionKey };
    const entry = { sessionId: `${kind}-${id}`, lifecycleRevision: `${kind}-revision-${id}` };
    await sessionAccessor.upsertSessionEntryCore(target, {
      ...entry,
      updatedAt: Date.now(),
      ...(spawnedBy ? { spawnedBy, spawnDepth: 1 } : {}),
    });
    return {
      entry,
      scope: {
        ...target,
        sessionId: entry.sessionId,
        storePath: (await loadSessionEntryAsync(sessionKey, target)).storePath,
      },
    };
  }
  const requester = await createSession("requester");
  const child = await createSession("child", requester.scope.sessionKey);
  const requesterScope = requester.scope;
  const childScope = child.scope;
  const childSessionKey = childScope.sessionKey;
  const createRun = async (index: 0 | 1) => {
    const runId = `completion-pair-${id}-${index}`;
    const revoked = new AbortController();
    const client = createOperatorClient({
      profileName: `completion-pair-${id}-${index}`,
      scopes: ["operator.write"],
    });
    const source = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: revoked.signal,
          assertCurrent: () => revoked.signal.throwIfAborted(),
        },
      }),
      "Expected an independent registered completion source",
    );
    client.internal = { operatorRunAuthority: source.authority };
    return {
      runId,
      result: index === 0 ? "FIRST_ONLY" : "SECOND_ONLY",
      idempotencyKey: buildAnnounceIdempotencyKey(
        buildAnnounceIdFromChildRun({ childSessionKey, childRunId: runId }),
      ),
      revoked,
      source,
      client,
      commandEntered: createDeferred(),
      releaseModel: createDeferred(),
      terminal: createDeferred(),
      settled: createDeferred(),
    };
  };
  const first = await createRun(0);
  let second: Awaited<ReturnType<typeof createRun>>;
  try {
    second = await createRun(1);
  } catch (error) {
    first.source.release();
    throw error;
  }
  const runs = [first, second] as const;
  const dispatches = new Map<0 | 1, Promise<unknown>>();
  const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
    for (const run of runs) {
      const entry = subagentRuns.get(run.runId);
      if (entry?.execution.status === "terminal") {
        run.terminal.resolve();
      }
      // A durable retry settles this attempt while retaining the delivery obligation.
      if (
        typeof entry?.cleanupCompletedAt === "number" ||
        (entry?.cleanupHandled === false && entry.delivery?.nextAttemptAt !== undefined) ||
        entry?.delivery?.status === "suspended" ||
        entry?.delivery?.status === "failed"
      ) {
        run.settled.resolve();
      }
    }
  });
  const runScoped = async <T>(index: 0 | 1, operation: () => Promise<T>): Promise<T> => {
    const root = expectDefined(
      tryBeginGatewayRootWorkAdmission("test:registered-completion-pair"),
      "Expected completion fixture root admission",
    );
    try {
      return await root.run(() =>
        withPluginRuntimeGatewayRequestScope(
          {
            client: runs[index].client,
            context,
            resolveGatewayContext: context.resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          operation,
        ),
      );
    } finally {
      root.release();
    }
  };
  const startDispatch = (index: 0 | 1) => {
    const existing = dispatches.get(index);
    if (existing) {
      return existing;
    }
    const run = runs[index];
    const dispatch = runScoped(index, () =>
      dispatchGatewayMethodInProcess(
        "agent",
        {
          sessionKey: childSessionKey,
          idempotencyKey: run.runId,
          message: index === 0 ? "First task" : "Second task",
          deliver: false,
        },
        { expectFinal: true, resolveGatewayContext: context.resolveGatewayContext },
      ),
    );
    dispatches.set(index, dispatch);
    void dispatch.catch(() => {});
    return dispatch;
  };
  const admit = async (index: 0 | 1) => {
    try {
      await awaitGateBeforeSettlement(
        runs[index].commandEntered.promise,
        startDispatch(index),
        "Child dispatch settled before entering its controlled model",
      );
    } finally {
      // The admitted execution and registered completion retain their own source custody.
      runs[index].source.release();
    }
  };
  const settle = async () => {
    await Promise.all(dispatches.values());
    await Promise.all([...dispatches.keys()].map((index) => runs[index].settled.promise));
  };
  const dispose = async () => {
    for (const run of runs) {
      run.releaseModel.resolve();
      run.revoked.abort(new Error("Registered completion fixture disposed"));
    }
    try {
      await Promise.allSettled(dispatches.values());
      await Promise.all(
        [...dispatches.keys()].flatMap((index) =>
          subagentRuns.get(runs[index].runId)?.execution.status === "terminal"
            ? [runs[index].settled.promise]
            : [],
        ),
      );
    } finally {
      await resetSubagentRegistryForTests({ persist: false });
      unsubscribe();
      for (const run of runs) {
        run.source.release();
      }
    }
  };
  try {
    await runScoped(0, () =>
      registerSubagentRun({
        runId: first.runId,
        childSessionKey,
        childAgentId: "main",
        sessionEntry: child.entry,
        requesterSessionKey: requesterScope.sessionKey,
        requesterAgentId: "main",
        requesterDisplayKey: requesterScope.sessionKey,
        task: "First task",
        cleanup: "keep",
        spawnMode: "session",
        expectsCompletionMessage: true,
        completionTarget: "parent",
        completionRequesterSessionId: requesterScope.sessionId,
        completionRequesterLifecycleRevision: requester.entry.lifecycleRevision,
        gatewayContextResolver: context.resolveGatewayContext,
      }),
    );
    return {
      requesterScope,
      childScope,
      runs,
      handleChildCommand(command: AgentCommandOpts) {
        const run = runs.find(
          (candidate) =>
            candidate.runId === command.runId && command.sessionKey === childSessionKey,
        );
        if (!run) {
          return undefined;
        }
        return (async () => {
          const recorder = expectDefined(
            command.userTurnTranscriptRecorder,
            "Expected real child execution input recorder",
          );
          await recorder.persistApproved();
          run.commandEntered.resolve();
          await run.releaseModel.promise;
          command.abortSignal?.throwIfAborted();
          const message: AssistantMessage & { __openclaw: { runId: string } } = {
            role: "assistant",
            content: [{ type: "text", text: run.result }],
            api: "openai-responses",
            provider: "openai",
            model: "synthetic-completion",
            usage: createZeroUsageFixture(),
            stopReason: "stop",
            timestamp: Date.now(),
            __openclaw: { runId: run.runId },
          };
          SessionManager.open(childScope).appendMessage(message);
          return {
            payloads: [{ text: run.result, mediaUrl: null }],
            meta: {
              durationMs: 1,
              terminalReply: { disposition: "visible" as const, text: run.result },
            },
          };
        })();
      },
      async complete(index: 0 | 1) {
        await admit(index);
        runs[index].releaseModel.resolve();
        await dispatches.get(index);
        await runs[index].terminal.promise;
      },
      admitSuccessor: () => admit(1),
      settle,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
