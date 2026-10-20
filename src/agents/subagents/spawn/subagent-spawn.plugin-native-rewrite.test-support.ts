import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  listSessionEntryKeysReadOnly,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import type { PluginHookBeforeToolCallEvent } from "../../../plugins/hook-types.js";
import { addTestHook, createMockPluginRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import type { NativeSubagentRuntime } from "../../../plugins/runtime/types-native-subagent.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../swarm/swarm-code-mode.js";
import {
  createSpawnBoundaryParent,
  createSpawnOperatorSource,
  recordSpawnBoundaryFinal,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundParent"]>>;

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
      return {
        payloads: [{ text: "rewrite child complete" }],
        meta: {
          durationMs: 1,
          terminalReply: { disposition: "visible", text: "rewrite child complete" },
        },
      };
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
            createRequestNativeSubagentRuntime(
              {
                options: {
                  config: parent.cfg,
                  agentId: "main",
                  sessionKey: parent.parentSessionKey,
                  sessionId: "parent-session",
                  runId: parent.parentRunId,
                  workspaceDir: resolveAgentWorkspaceDir(parent.cfg, "main"),
                  senderIsOwner: true,
                  allowGatewaySubagentBinding: true,
                  runtimeToolAllowlist: ["sessions_spawn", "agents_wait", "read"],
                  inheritRuntimeToolAllowlist: true,
                },
                operatorAuthority: owner.authority,
                assertCurrent: owner.authority.assertCurrent,
                async prepareSpawn(assertCurrent) {
                  assertCurrent();
                  return parent.admitted;
                },
              },
              { pluginId: "native-test", assertCurrent: owner.authority.assertCurrent },
            );
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
        const hooks = createMockPluginRegistry([]);
        addTestHook({
          registry: hooks,
          pluginId: "nested-collector-test",
          hookName: "before_tool_call",
          handler: async (event: PluginHookBeforeToolCallEvent) => {
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
          },
        });
        initializeGlobalHookRunner(hooks);
        const outer = await native.collect({ ids: [childA.runId], timeoutSeconds: 0 });
        expect(outer).toMatchObject({
          completed: [{ runId: childA.runId, status: "done" }],
          pending: [],
        });
        const [own, foreign, sameIdForeign, reentrant] = expectDefined(
          nested,
          "nested waits completed",
        );
        expect(sameIdForeign.details).toMatchObject({
          completed: [],
          pending: [],
          errors: [{ runId: childA.runId, error: "not_owner" }],
        });
        expect(own.details).toMatchObject({
          completed: [{ runId: childB.runId, status: "done" }],
          pending: [],
        });
        expect(foreign.details).toMatchObject({
          completed: [],
          pending: [],
          errors: [{ runId: childA.runId, error: "not_owner" }],
        });
        expect(reentrant).toMatchObject({
          completed: [{ runId: childB.runId, status: "done" }],
          pending: [],
        });
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
  ])("native plugin rejects incompatible finalized rewrite: $name", async ({ rewrite }) => {
    await withRewriteFixture(async ({ native, bound }) => {
      const keys = () => listSessionEntryKeysReadOnly({ storePath: bound.storePath });
      const before = await keys();
      const hook = vi.fn(async (event: { toolName: string }) =>
        event.toolName === "sessions_spawn" ? { params: rewrite } : undefined,
      );
      const hooks = createMockPluginRegistry([]);
      addTestHook({
        registry: hooks,
        pluginId: "native-rewrite-test",
        hookName: "before_tool_call",
        handler: hook,
      });
      initializeGlobalHookRunner(hooks);
      await expect(
        native.spawn({ requestId: "rewrite", task: "original", context: "isolated" }),
      ).rejects.toThrow("Native subagent hooks must preserve collector mode and replay identity.");
      expect(hook).toHaveBeenCalledTimes(1);
      expect(await keys()).toEqual(before);
      expect(subagentRuns.size).toBe(0);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });

  it("native plugin permits task rewrites and nested ordinary noncollector calls", async () => {
    await withRewriteFixture(async ({ native, ordinary, bound, modelsStarted }) => {
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
      const hooks = createMockPluginRegistry([]);
      addTestHook({
        registry: hooks,
        pluginId: "native-rewrite-test",
        hookName: "before_tool_call",
        handler: hook,
      });
      initializeGlobalHookRunner(hooks);
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
      await settleRootWork(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });
}
