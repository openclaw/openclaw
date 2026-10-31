/** Pending native preparation must transfer only live invocation authority to the child owner. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  installSpawnAuthorityFixture,
  installSpawnThreadBindingFixture,
  installSpawnAttachmentFixture,
} from "./subagent-spawn.authority.test-support.js";
import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-spawn-model.mocks.shared.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { forkSessionEntryFromParent } from "../../../auto-reply/reply/session-fork.js";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  listSessionChildEntriesReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../../gateway/methods/registry.js";
import { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayLifecycleRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import { invokeChatAbortHandler } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionDeleteHandlers } from "../../../gateway/server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import type { DispatchGatewayMethodInProcessOptions } from "../../../gateway/server-plugin-in-process-dispatch.types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { getAdmittedRunDelegatedAuthority } from "../../admitted-run-context.js";
import { finalizeAgentToolAvailability } from "../../agent-tool-availability.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { holdSpawnCapacity } from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});
const { parentSessionKey, parentRunId, groupId, createBoundParent } = fixture;
type BoundParent = Awaited<ReturnType<typeof createBoundParent>>;

function asCaller<T>({ context, admitted }: BoundParent, run: () => T) {
  return withPluginRuntimeGatewayRequestScope(
    { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
    () =>
      withGatewayToolCallerIdentity(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: parentSessionKey,
        }),
        run,
      ),
  );
}

function parentToolOptions(config: BoundParent["cfg"]) {
  return {
    config,
    agentSessionKey: parentSessionKey,
    requesterRunId: parentRunId,
    requesterTurnRunId: parentRunId,
  };
}

function finalizeParentTools(bound: BoundParent, tools: AnyAgentTool[]) {
  return finalizeAgentTools({
    tools,
    hookContext: {
      config: bound.cfg,
      agentId: "main",
      sessionKey: parentSessionKey,
      runId: parentRunId,
    },
    abortSignal: bound.parent.controller.signal,
  });
}

function spawnDispatch(
  gateway: ReturnType<typeof createPreparationGateway>,
  dispatch: (params: Record<string, unknown>) => unknown,
  allowAbort = false,
) {
  return async <T>(
    method: string,
    params: Record<string, unknown>,
    options?: DispatchGatewayMethodInProcessOptions,
  ) => {
    if (method === "agent") {
      await dispatch(params);
      return { runId: params.idempotencyKey, status: "accepted" } as T;
    }
    if (method !== "sessions.delete" && !(allowAbort && method === "chat.abort")) {
      throw new Error(`Unexpected spawn RPC ${method}`);
    }
    return await gateway.dispatchSessionMethod<T>(method, params, {
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
      assertCurrent: options?.sessionMutationCommitGuard,
    });
  };
}

function createPreparationGateway(context: BoundParent["context"], deleted: string[]) {
  const gatewayContext = context as unknown as GatewayRequestContext;
  const recovery = gatewayContext.lifecycleRuntime;
  if (!recovery) {
    throw new Error("Preparation fixture requires its Gateway recovery owner");
  }
  const originalDispatch = recovery.dispatchSessionMethod;
  const originalTrackExecution = gatewayContext.trackExecution;
  const failures = new Set<unknown>();
  const execution = new AsyncWorkScope(failures);
  gatewayContext.trackExecution = <T>(run: () => T | Promise<T>) => execution.track(run);
  const registry = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors({
      "chat.abort": handleChatAbortRequest,
      "sessions.delete": sessionDeleteHandlers["sessions.delete"]!,
    }),
  );
  const runtime = createGatewayInstanceRuntime({
    getContext: () => gatewayContext,
    getMethodRegistry: () => registry,
    isDispatchAvailable: () => !execution.isClosing,
  });
  const dispatchSessionMethod: GatewayLifecycleRuntime["dispatchSessionMethod"] = async <T>(
    method: Parameters<GatewayLifecycleRuntime["dispatchSessionMethod"]>[0],
    params: unknown,
    options?: Parameters<GatewayLifecycleRuntime["dispatchSessionMethod"]>[2],
  ) => {
    const result = await runtime.lifecycle.dispatchSessionMethod<T>(method, params, options);
    if (method === "sessions.delete") {
      deleted.push((params as { key: string }).key);
    } else if (method === "chat.abort") {
      expect(result).toEqual(
        expect.objectContaining({ aborted: true, runIds: [(params as { runId: string }).runId] }),
      );
    }
    return result;
  };
  recovery.dispatchSessionMethod = dispatchSessionMethod;
  return {
    dispatchSessionMethod,
    async close() {
      try {
        await AsyncWorkScope.runWhenAllIdle(
          () => [execution],
          () => execution.drain(),
        );
      } finally {
        try {
          runtime.close();
        } finally {
          recovery.dispatchSessionMethod = originalDispatch;
          gatewayContext.trackExecution = originalTrackExecution;
        }
      }
      if (failures.size > 0) {
        throw new AggregateError([...failures], "Preparation Gateway cleanup failed");
      }
    },
  };
}

describe("pending spawn preparation authority", () => {
  it.each(["closed", "live"])(
    "checks parent authority after queued fork preparation: %s",
    async (closure) => {
      const bound = await createBoundParent();
      const { cfg, storePath, context, admission, parent, admitted } = bound;
      for (const message of [
        { role: "user", content: "synthetic parent context" },
        { role: "assistant", content: "synthetic completed reply", stopReason: "stop" },
      ]) {
        await appendTranscriptMessage(
          { agentId: "main", sessionId: "parent-session", sessionKey: parentSessionKey, storePath },
          { message },
        );
      }
      const writerGate = createEnteredGate();
      const forkQueued = createDeferred<{ childSessionKey: string; initialSessionId: string }>();
      const forkSettled = createDeferred<
        Awaited<ReturnType<typeof forkSessionEntryFromParent>> | Error
      >();
      const inspected = createDeferred();
      let blocker: Promise<void> | undefined;
      const dispatch = vi.fn();
      const deleted: string[] = [];
      const gateway = createPreparationGateway(context, deleted);
      spawnTesting.setDepsForTest({
        forkSessionEntryFromParent: async (params) => {
          // Hold a genuine preceding database writer, then enqueue the real fork owner.
          blocker = runExclusiveSqliteSessionWrite(
            resolveSqliteStoreScope(storePath),
            writerGate.wait,
            "session.transcript.batch",
          );
          await writerGate.entered;
          const initial = loadSessionEntry({ storePath, sessionKey: params.sessionKey })!;
          const pending = forkSessionEntryFromParent(params);
          forkQueued.resolve({
            childSessionKey: params.sessionKey,
            initialSessionId: initial.sessionId,
          });
          try {
            const result = await pending;
            forkSettled.resolve(result);
            await inspected.promise;
            return result;
          } catch (error) {
            forkSettled.resolve(error instanceof Error ? error : new Error(String(error)));
            await inspected.promise;
            throw error;
          }
        },
        resolveContextEngine: async () => new LegacyContextEngine(),
        dispatchGatewayMethodInProcess: spawnDispatch(gateway, dispatch),
      });
      const [tool] = finalizeParentTools(bound, [createSessionsSpawnTool(parentToolOptions(cfg))]);
      const pending = asCaller(bound, () =>
        tool!.execute!("spawn-fork-queued", {
          task: "bounded fork",
          context: "fork",
          mode: "run",
          expectsCompletionMessage: false,
        }),
      ).catch((error: unknown) => error);
      try {
        const { childSessionKey, initialSessionId } = await Promise.race([
          forkQueued.promise,
          pending.then((result) => {
            throw new Error(`Spawn settled before fork queue: ${JSON.stringify(result)}`);
          }),
        ]);
        expect(subagentRuns.size).toBe(0);
        expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toMatchObject({
          model: "gpt-5.4",
          modelProvider: "openai",
          modelOverride: "gpt-5.4",
          providerOverride: "openai",
        });
        if (closure === "closed") {
          admission.close();
          expect(parent.controller.signal.aborted).toBe(false);
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        }
        writerGate.release();
        const result = await forkSettled.promise;
        const entry = loadSessionEntry({ storePath, sessionKey: childSessionKey })!;
        const transcript = await loadTranscriptEvents({
          agentId: "main",
          sessionId: entry.sessionId,
          sessionKey: childSessionKey,
          storePath,
        });
        if (closure === "closed") {
          expect.soft(entry.sessionId).toBe(initialSessionId);
          expect.soft(transcript).toEqual([]);
          expect.soft(result).toBeInstanceOf(Error);
        } else {
          expect(result).toMatchObject({ status: "forked" });
          expect(entry.sessionId).not.toBe(initialSessionId);
          expect(entry).toMatchObject({ model: "gpt-5.4", modelProvider: "openai" });
          expect(transcript).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: { role: "user", content: "synthetic parent context" },
              }),
            ]),
          );
        }
        inspected.resolve();
        const outcome = await pending;
        if (closure === "closed") {
          expect(outcome).toMatchObject({ details: { status: "error" } });
          expect(dispatch).not.toHaveBeenCalled();
          expect(subagentRuns.size).toBe(0);
          expect(deleted).toEqual([childSessionKey]);
          expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
        } else {
          expect(outcome).toMatchObject({ details: { status: "accepted" } });
          expect(dispatch).toHaveBeenCalledOnce();
        }
      } finally {
        writerGate.release();
        inspected.resolve();
        await blocker;
        await pending;
        try {
          await gateway.close();
        } finally {
          admission.close();
          parent.cleanup();
        }
      }
    },
  );

  it.each([
    "native engine resolution",
    "native thread binding",
    "native attachment staging",
    "native attachment directory",
    "native attachment files",
    "native abort",
    "native acceptance",
    "native call signal",
    "native construction signal",
    "native admission close",
    "projected close",
  ])("rolls back an untransferred native spawn: %s", async (closure) => {
    const entered = createDeferred<string>();
    const release = createDeferred();
    const hasThread =
      closure === "native thread binding" || closure === "native attachment staging";
    const hasAttachments = closure.startsWith("native attachment");
    const bindingFixture = hasThread
      ? installSpawnThreadBindingFixture(async (binding) => {
          if (closure === "native attachment staging") {
            entered.resolve(binding.targetSessionKey);
            await release.promise;
          }
        })
      : undefined;
    const bound = await createBoundParent(
      closure.startsWith("projected") ? "plugin-harness" : "embedded",
    );
    const { cfg, storePath, context, admission, parent, admitted } = bound;
    if (closure === "native thread binding") {
      await replaceTranscriptEvents(
        { agentId: "main", sessionId: "parent-session", sessionKey: parentSessionKey, storePath },
        [
          {
            type: "session",
            version: 3,
            id: "parent-session",
            timestamp: "2026-09-05T00:00:00Z",
            cwd: fixture.stateDir,
          },
        ],
      );
    }
    const readChildKey = async () =>
      (await listSessionChildEntriesReadOnly({ storePath, sessionKey: parentSessionKey }))[0]!
        .sessionKey;
    const attachmentFixture = hasAttachments
      ? installSpawnAttachmentFixture({
          stateDir: fixture.stateDir,
          admitted,
          pauseAt:
            closure === "native attachment directory"
              ? "directory"
              : closure === "native attachment files"
                ? "files"
                : undefined,
          entered: async () => entered.resolve(await readChildKey()),
          release: release.promise,
        })
      : undefined;
    const acceptedGate = createDeferred();
    const acceptedEntered = createDeferred();
    let childController: ReturnType<typeof registerChatAbortController> | undefined;
    const rollback = vi.fn(async () => {});
    const prepare = vi.fn(async ({ childSessionKey }: { childSessionKey: string }) => {
      entered.resolve(childSessionKey);
      await release.promise;
      return { rollback };
    });
    const agentDispatch = vi.fn();
    const deleted: string[] = [];
    const gateway = createPreparationGateway(context, deleted);
    spawnTesting.setDepsForTest({
      forkSessionEntryFromParent: async (params) => {
        const result = await forkSessionEntryFromParent(params);
        if (closure === "native thread binding") {
          entered.resolve(params.sessionKey);
          await release.promise;
        }
        return result;
      },
      resolveContextEngine: async () => {
        if (closure === "native engine resolution") {
          entered.resolve(await readChildKey());
          await release.promise;
        }
        return Object.assign(new LegacyContextEngine(), { prepareSubagentSpawn: prepare });
      },
      dispatchGatewayMethodInProcess: spawnDispatch(
        gateway,
        async (params) => {
          agentDispatch(params);
          if (closure === "native acceptance") {
            const childSessionKey = params.sessionKey as string;
            const child = loadSessionEntry({ storePath, sessionKey: childSessionKey })!;
            childController = registerChatAbortController({
              target: captureSessionTarget({
                storeScope: storePath,
                sessionKey: childSessionKey,
                incarnation: child.sessionId,
                agentId: "main",
              }),
              runId: params.idempotencyKey as string,
              sessionKey: childSessionKey,
              sessionId: child.sessionId,
              agentId: "main",
              timeoutMs: 60_000,
            });
            acceptedEntered.resolve();
            await acceptedGate.promise;
          }
        },
        true,
      ),
    });
    const invocationAbort = new AbortController();
    const host = closure.startsWith("projected")
      ? createAgentHarnessHostCapabilities({
          attempt: {
            admittedRunContext: admitted,
            runId: parentRunId,
            config: cfg,
            agentId: "main",
            sessionKey: parentSessionKey,
            abortSignal: parent.controller.signal,
          },
          pluginId: "test-harness",
        })
      : undefined;
    const source = createSessionsSpawnTool({
      ...parentToolOptions(cfg),
      agentChannel: hasThread ? "matrix" : undefined,
      agentAccountId: hasThread ? "default" : undefined,
      agentTo: hasThread ? "room:parent" : undefined,
      signal: closure === "native construction signal" ? invocationAbort.signal : undefined,
    });
    let forwarded: Promise<unknown> | undefined;
    const observed = copyAgentToolMetadata(source, {
      ...source,
      execute: (...args) => {
        const pending = source.execute!(...args);
        forwarded = pending.catch((error: unknown) => error);
        return pending;
      },
    });
    const wait = createAgentsWaitTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      agentId: "main",
    });
    const tools = [observed, wait];
    const [tool] = host
      ? finalizeAgentToolAvailability(host.capabilities.bindToolSurface(tools))
      : finalizeParentTools(bound, tools);
    const wrapped = asCaller(bound, () =>
      tool!.execute!(
        "spawn-pending",
        {
          task: "bounded child",
          collect: closure !== "native acceptance" && !hasThread,
          thread: hasThread,
          context: closure === "native thread binding" ? "fork" : "isolated",
          attachments: hasAttachments
            ? [{ name: "synthetic.txt", content: "synthetic attachment" }]
            : undefined,
          groupId: closure === "native acceptance" || hasThread ? undefined : groupId,
        },
        closure === "native call signal" ? invocationAbort.signal : undefined,
      ),
    );
    const wrappedOutcome = wrapped.catch((error: unknown) => error);
    try {
      // A rejected spawn never enters preparation; report it instead of waiting for the test timeout.
      const childSessionKey = await awaitGateBeforeSettlement(
        entered.promise,
        wrapped,
        "Spawn settled before entering context preparation",
      );
      expect(subagentRuns.size).toBe(0);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeDefined();
      if (closure === "native acceptance") {
        release.resolve();
        await acceptedEntered.promise;
        expect(subagentRuns.size).toBe(0);
        expect(childController?.controller.signal.aborted).toBe(false);
      }
      if (closure === "native abort" || closure === "native acceptance") {
        const reply = await invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey: parentSessionKey, runId: parentRunId },
          client: {
            connId: "owner-connection",
            connect: { scopes: ["operator.read", "operator.write"] },
          },
        });
        expect(reply).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [parentRunId],
        });
        expect(parent.controller.signal.aborted).toBe(true);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        expect(await wrappedOutcome).toBeInstanceOf(Error);
      } else {
        if (closure === "projected close") {
          host!.close();
        } else if (closure.endsWith("signal")) {
          invocationAbort.abort();
        } else {
          admission.close();
        }
        expect(parent.controller.signal.aborted).toBe(false);
      }
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      if (closure === "native acceptance") {
        expect(agentDispatch).toHaveBeenCalledOnce();
        expect(childController?.controller.signal.aborted).toBe(true);
      } else {
        expect(agentDispatch).not.toHaveBeenCalled();
      }
      expect(subagentRuns.size).toBe(0);
      const closedBeforePreparation =
        closure === "native engine resolution" || hasThread || hasAttachments;
      if (closedBeforePreparation) {
        expect.soft(prepare).not.toHaveBeenCalled();
        expect.soft(rollback).not.toHaveBeenCalled();
      } else {
        expect(rollback).toHaveBeenCalledOnce();
      }
      if (closure === "native thread binding") {
        expect.soft(bindingFixture!.bind).not.toHaveBeenCalled();
      }
      if (closure === "native attachment staging") {
        expect(bindingFixture!.bind).toHaveBeenCalledOnce();
      }
      expect.soft(attachmentFixture?.lateWrites ?? []).toEqual([]);
      expect(bindingFixture?.bindings ?? []).toEqual([]);
      for (const directory of attachmentFixture?.attachmentDirs ?? []) {
        await expect(fs.stat(directory), directory).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(deleted).toEqual([childSessionKey]);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
      await holdSpawnCapacity(
        JSON.stringify(["main", parentSessionKey, groupId]),
        "surviving-reservation",
      );
    } finally {
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      await wrappedOutcome;
      try {
        await gateway.close();
      } finally {
        childController?.cleanup();
        host?.close();
        admission.close();
        parent.cleanup();
        attachmentFixture?.restore();
        bindingFixture?.unregister();
      }
    }
  });
});
