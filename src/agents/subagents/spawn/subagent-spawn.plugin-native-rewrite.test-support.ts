import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { runWithReplyNativeSubagents } from "../../../auto-reply/reply/dispatch-native-subagent.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import {
  listSessionEntryKeysReadOnly,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import type { PluginHookRegistration } from "../../../plugins/hook-types.js";
import { addTestHook, createMockPluginRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withNativeSubagentRuntimeGuard } from "../../../plugins/runtime/native-subagent-context.js";
import type { NativeSubagentRuntime } from "../../../plugins/runtime/types-native-subagent.js";
import type { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import type { NativeSubagentRequestSource } from "../../plugin-native-subagent.types.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { activateSubagentRegistry } from "../registry/subagent-registry.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../swarm/swarm-code-mode.js";
import { visibleResult } from "./subagent-spawn.fixtures.test-support.js";
import {
  createSpawnBoundaryParent,
  createSpawnOperatorSource,
  holdSpawnCapacity,
  recordSpawnBoundaryFinal,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundParent"]>>;
type OperatorSource = ReturnType<typeof createSpawnOperatorSource>;

export function installNativeToolHook(
  pluginId: string,
  handler: PluginHookRegistration<"before_tool_call">["handler"],
) {
  const hooks = createMockPluginRegistry([]);
  addTestHook({ registry: hooks, pluginId, hookName: "before_tool_call", handler });
  initializeGlobalHookRunner(hooks);
}

export function nativeRequestSource(
  bound: BoundParent,
  source: OperatorSource,
  overrides: Partial<NativeSubagentRequestSource["options"]> = {},
): NativeSubagentRequestSource {
  return {
    options: {
      config: bound.cfg,
      agentId: "main",
      sessionKey: bound.parentSessionKey,
      sessionId: "parent-session",
      runId: bound.parentRunId,
      workspaceDir: resolveAgentWorkspaceDir(bound.cfg, "main"),
      senderIsOwner: true,
      allowGatewaySubagentBinding: true,
      runtimeToolAllowlist: ["sessions_spawn", "agents_wait", "read"],
      inheritRuntimeToolAllowlist: true,
      ...overrides,
    },
    operatorAuthority: source.authority,
    assertCurrent: source.authority.assertCurrent,
    async prepareSpawn(assertCurrent) {
      assertCurrent();
      return bound.admitted;
    },
  };
}

export async function holdNativeCapacity(bound: BoundParent, runId: string) {
  const { parentSessionKey, parentRunId } = bound;
  await holdSpawnCapacity(
    JSON.stringify(["main", parentSessionKey, `swarm:${parentSessionKey}:${parentRunId}`]),
    runId,
  );
}

export function nativeReplyFixture(
  bound: BoundParent,
  context: Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundGateway"]>>["context"],
  entry: NonNullable<ReturnType<typeof loadSessionEntry>>,
  recorder: ReturnType<typeof createUserTurnTranscriptRecorder>,
  text: string,
  adopt: () => Promise<void>,
  toolsAllow = ["sessions_spawn", "agents_wait", "read"],
) {
  return (source: OperatorSource, runId: string, run: () => Promise<void>, withAuthority = true) =>
    withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
      runWithReplyNativeSubagents(
        {
          cfg: bound.cfg,
          ctx: buildTestCtx({
            Body: text,
            SessionKey: bound.parentSessionKey,
            CommandAuthorized: true,
          }),
          params: {
            replyOptions: {
              runId,
              operatorAuthority: withAuthority ? source.authority : undefined,
              toolsAllow,
              userTurnTranscriptRecorder: recorder,
            },
          },
          sessionAgentId: "main",
          sessionKey: bound.parentSessionKey,
          sessionStoreEntry: { sessionKey: bound.parentSessionKey, entry },
          getPreDispatchAbortSignal: () => undefined,
          assertProgressCurrent: source.authority.assertCurrent,
          assertCurrentBindingRoute: async () => {
            source.authority.assertCurrent();
          },
          turnAdoption: { assertCurrent: source.authority.assertCurrent, adopt },
        },
        () =>
          withNativeSubagentRuntimeGuard(
            { pluginId: "native-test", assertCurrent: source.authority.assertCurrent },
            run,
          ),
      ),
    );
}

export function registerNativePluginRewriteCases(options: NativePluginSpawnTestOptions) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    waitForEmbeddedRun,
    settleRootWork,
    throwBoundFailures,
    runEmbeddedAgent,
  } = options;
  async function withRewriteFixture(
    test: (fixture: {
      native: NativeSubagentRuntime;
      ordinary: AnyAgentTool;
      bound: BoundParent;
      runtime: Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundGateway"]>>["runtime"];
      modelsStarted: Promise<void>;
      makeNative: (
        parent: BoundParent,
        owner: ReturnType<typeof createSpawnOperatorSource>,
      ) => NativeSubagentRuntime;
    }) => Promise<void>,
  ) {
    const source = createSpawnOperatorSource();
    const bound = await createBoundParent(source.authority);
    const { context, runtime } = await createBoundGateway(bound);
    const failures: unknown[] = [];
    const modelsStarted = createDeferred();
    runEmbeddedAgent.mockImplementation(async (params) => {
      if (runEmbeddedAgent.mock.calls.length === 2) {
        modelsStarted.resolve();
      }
      await recordSpawnBoundaryFinal({
        storePath: bound.storePath,
        sessionKey: expectDefined(params.sessionKey, "rewrite child session"),
        runId: params.runId,
        text: "rewrite child complete",
      });
      return visibleResult("rewrite child complete");
    });
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        async () => {
          const { createRequestNativeSubagentRuntime } =
            await import("../../plugin-native-subagent.js");
          const makeNative = (
            parent: BoundParent,
            owner: ReturnType<typeof createSpawnOperatorSource>,
          ) =>
            createRequestNativeSubagentRuntime(nativeRequestSource(parent, owner), {
              pluginId: "native-test",
              assertCurrent: owner.authority.assertCurrent,
            });
          const [ordinary] = finalizeAgentTools({
            tools: [
              createSessionsSpawnTool({
                config: bound.cfg,
                senderIsOwner: true,
                agentSessionKey: bound.parentSessionKey,
                expectedParentSessionId: "parent-session",
                requesterRunId: bound.parentRunId,
                requesterTurnRunId: bound.parentRunId,
              }),
            ],
            hookContext: {
              config: bound.cfg,
              agentId: "main",
              sessionKey: bound.parentSessionKey,
              runId: bound.parentRunId,
            },
          });
          await test({
            native: makeNative(bound, source),
            makeNative,
            ordinary: expectDefined(ordinary, "ordinary spawn"),
            bound,
            runtime,
            modelsStarted: modelsStarted.promise,
          });
        },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      resetGlobalHookRunner();
      failures.push(...(await closeBoundGateway(bound, runtime)));
      source.closeRequest();
      throwBoundFailures(failures);
    }
  }

  it("native plugin binds collector ownership to the intended tool across nested waits", async () => {
    await withRewriteFixture(async ({ native, bound, modelsStarted, makeNative }) => {
      const ownerB = createSpawnOperatorSource("collector-b");
      const parentB = await createSpawnBoundaryParent({
        stateDir: resolveAgentWorkspaceDir(bound.cfg, "main"),
        parentSessionKey: "agent:main:collector-b",
        parentRunId: "collector-b-parent",
        operatorAuthority: ownerB.authority,
      });
      const gatewayB = await createBoundGateway(parentB);
      const failures: unknown[] = [];
      try {
        const nativeB = withPluginRuntimeGatewayRequestScope(
          { context: gatewayB.context, isWebchatConnect: () => false },
          () => makeNative(parentB, ownerB),
        );
        const [waitB] = finalizeAgentTools({
          tools: [
            createAgentsWaitTool({
              config: parentB.cfg,
              agentSessionKey: parentB.parentSessionKey,
              agentId: "main",
            }),
          ],
          hookContext: {
            config: parentB.cfg,
            agentId: "main",
            sessionKey: parentB.parentSessionKey,
            runId: parentB.parentRunId,
          },
        });
        const ordinaryB = expectDefined(waitB, "ordinary B wait");
        const [childA, childB] = await Promise.all([
          native.spawn({ requestId: "owner-a", task: "A", context: "isolated" }),
          nativeB.spawn({ requestId: "owner-b", task: "B", context: "isolated" }),
        ]);
        await waitForEmbeddedRun(bound, childA.runId, modelsStarted, 2);
        await Promise.all([
          native.collect({ ids: [childA.runId], awaitResults: true }),
          nativeB.collect({ ids: [childB.runId], awaitResults: true }),
        ]);
        type WaitResult = Awaited<ReturnType<AnyAgentTool["execute"]>>;
        let nested:
          | [
              WaitResult,
              WaitResult,
              WaitResult,
              Awaited<ReturnType<NativeSubagentRuntime["collect"]>>,
            ]
          | undefined;
        let outerCallId: string | undefined;
        let nestedHookActive = false;
        installNativeToolHook("nested-collector-test", async (event) => {
          if (
            event.toolName !== "agents_wait" ||
            !Array.isArray(event.params.ids) ||
            !event.params.ids.includes(childA.runId) ||
            nestedHookActive
          ) {
            return;
          }
          outerCallId = event.toolCallId;
          const callId = expectDefined(event.toolCallId, "hook-visible native call ID");
          nestedHookActive = true;
          try {
            nested = await Promise.all([
              ordinaryB.execute(callId, { ids: [childB.runId], timeoutSeconds: 0 }),
              ordinaryB.execute("ordinary-b-foreign", { ids: [childA.runId], timeoutSeconds: 0 }),
              ordinaryB.execute(callId, { ids: [childA.runId], timeoutSeconds: 0 }),
              nativeB.collect({ ids: [childB.runId], timeoutSeconds: 0 }),
            ]);
          } finally {
            nestedHookActive = false;
          }
        });
        const outer = await native.collect({ ids: [childA.runId], timeoutSeconds: 0 });
        expect(outer).toMatchObject({
          completed: [{ runId: childA.runId, status: "done" }],
          pending: [],
        });
        const [own, foreign, sameIdForeign, reentrant] = expectDefined(
          nested,
          "nested waits completed",
        );
        const notOwner = {
          completed: [],
          pending: [],
          errors: [{ runId: childA.runId, error: "not_owner" }],
        };
        const done = {
          completed: [{ runId: childB.runId, status: "done" }],
          pending: [],
        };
        expect([sameIdForeign.details, foreign.details]).toMatchObject([notOwner, notOwner]);
        expect([own.details, reentrant]).toMatchObject([done, done]);
        resetGlobalHookRunner();
        // Even reusing the completed native call ID must not retain its host-only owner.
        const after = await ordinaryB.execute(expectDefined(outerCallId, "outer call ID"), {
          ids: [childB.runId, childA.runId],
          timeoutSeconds: 0,
        });
        expect(after.details).toMatchObject({
          completed: [{ runId: childB.runId, status: "done" }],
          pending: [],
          errors: [{ runId: childA.runId, error: "not_owner" }],
        });
      } catch (error) {
        failures.push(error);
      } finally {
        resetGlobalHookRunner();
        failures.push(...(await closeBoundGateway(parentB, gatewayB.runtime)));
        ownerB.closeRequest();
        throwBoundFailures(failures);
      }
    });
  });

  it.each([
    { name: "collect false", rewrite: { collect: false } },
    { name: "noncollector ACP", rewrite: { collect: false, runtime: "acp" } },
    { name: "session mode", rewrite: { mode: "session" } },
    { name: "collect cleared", rewrite: { collect: undefined } },
    { name: "replay key cleared", rewrite: { [SWARM_CODE_MODE_IDEMPOTENCY_KEY]: undefined } },
    { name: "replay key replaced", rewrite: { [SWARM_CODE_MODE_IDEMPOTENCY_KEY]: "different" } },
    { name: "fingerprint cleared", rewrite: { [SWARM_CODE_MODE_REQUEST_FINGERPRINT]: undefined } },
    {
      name: "fingerprint replaced",
      rewrite: { [SWARM_CODE_MODE_REQUEST_FINGERPRINT]: "different" },
    },
    // A hook must not quietly unblind a child the plugin asked to keep blind.
    { name: "blind cleared", rewrite: { blind: undefined }, blind: true },
    { name: "blind disabled", rewrite: { blind: false }, blind: true },
  ])("native plugin rejects incompatible finalized rewrite: $name", async ({ rewrite, blind }) => {
    await withRewriteFixture(async ({ native, bound }) => {
      const keys = () => listSessionEntryKeysReadOnly({ storePath: bound.storePath });
      const before = await keys();
      const hook = vi.fn(async (event: { toolName: string }) =>
        event.toolName === "sessions_spawn" ? { params: rewrite } : undefined,
      );
      installNativeToolHook("native-rewrite-test", hook);
      await expect(
        native.spawn({
          requestId: "rewrite",
          task: "original",
          context: "isolated",
          ...(blind ? { blind } : {}),
        }),
      ).rejects.toThrow("Native subagent hooks must preserve collector mode and replay identity.");
      expect(hook).toHaveBeenCalledTimes(1);
      expect(await keys()).toEqual(before);
      expect(subagentRuns.size).toBe(0);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });

  it("native plugin keeps a blind requester's children blind and never forks its transcript", async () => {
    await withRewriteFixture(async ({ native, bound }) => {
      await upsertSessionEntryCore(
        { storePath: bound.storePath, sessionKey: bound.parentSessionKey },
        { blindPrompt: true },
      );
      const keys = () => listSessionEntryKeysReadOnly({ storePath: bound.storePath });
      const before = await keys();
      // The child would inherit blinding, and a fork would copy the requester's own transcript.
      await expect(
        native.spawn({ requestId: "inherited-fork", task: "forked", context: "fork" }),
      ).rejects.toThrow('Blind spawns require context="isolated"');
      expect(await keys()).toEqual(before);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();

      const accepted = await native.spawn({
        requestId: "inherited",
        task: "inherited blind task",
        context: "isolated",
      });
      expect(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: accepted.childSessionKey }),
      ).toMatchObject({ blindPrompt: true });
      await native.collect({ ids: [accepted.runId], awaitResults: true });
      const [run] = expectDefined(
        runEmbeddedAgent.mock.calls.find(
          ([params]) => params.sessionKey === accepted.childSessionKey,
        ),
        "inherited blind child run",
      );
      expect(run.blindPrompt).toBe(true);
      expect(run.prompt).toContain("inherited blind task");
      expect(run.prompt).not.toContain("Your session:");
      expect(run.prompt).not.toContain(bound.parentSessionKey);
    });
  });

  it("native plugin permits task rewrites and nested ordinary noncollector calls", async () => {
    await withRewriteFixture(async ({ native, ordinary, bound, runtime, modelsStarted }) => {
      vi.mocked(runtime.lifecycle.waitForAgent).mockRestore();
      await activateSubagentRegistry(bound.resolveGatewayContext);
      let ordinaryRunId: string | undefined;
      const hook = vi.fn(async (event: { toolName: string; params: Record<string, unknown> }) => {
        if (event.toolName !== "sessions_spawn") {
          return undefined;
        }
        if (event.params.label === "ordinary-control") {
          return { params: { task: "ordinary rewritten" } };
        }
        const accepted = expectDefined(
          normalizeAcceptedSessionSpawnResult(
            await ordinary.execute("nested-ordinary", {
              task: "ordinary original",
              label: "ordinary-control",
              collect: false,
              context: "isolated",
            }),
          ),
          "ordinary accepted child",
        );
        ordinaryRunId = accepted.runId;
        expect(accepted.expectsCompletionMessage).toBe(true);
        return { params: { task: "native rewritten", label: "native-rewritten" } };
      });
      installNativeToolHook("native-rewrite-test", hook);
      const request = {
        requestId: "permitted",
        task: "native original",
        context: "isolated" as const,
      };
      const accepted = await native.spawn(request);
      expect(await native.spawn(request)).toEqual(accepted);
      expect(hook).toHaveBeenCalledTimes(2);
      expect(subagentRuns.size).toBe(2);
      expect(subagentRuns.get(expectDefined(ordinaryRunId, "ordinary run"))).toMatchObject({
        collect: false,
        expectsCompletionMessage: true,
      });
      expect(subagentRuns.get(accepted.runId)).toMatchObject({
        collect: true,
        swarmLaunchReplayKey: expect.any(String),
      });
      expect(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: accepted.childSessionKey }),
      ).toMatchObject({ label: "native-rewritten" });
      await waitForEmbeddedRun(bound, accepted.runId, modelsStarted, 2);
      const prompts = runEmbeddedAgent.mock.calls.map(([params]) => params.prompt);
      expect(prompts).toEqual(
        expect.arrayContaining([
          expect.stringContaining("native rewritten"),
          expect.stringContaining("ordinary rewritten"),
        ]),
      );
      for (const prompt of prompts) {
        expect(prompt).not.toContain("native original");
        expect(prompt).not.toContain("ordinary original");
      }
      expect(await native.collect({ ids: [accepted.runId], awaitResults: true })).toMatchObject({
        completed: [{ runId: accepted.runId, status: "done", result: "rewrite child complete" }],
        pending: [],
      });
      await bound.execution.runWhenIdle(() => {});
      await settleRootWork(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });
}
