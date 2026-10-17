import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { runWithReplyNativeSubagents } from "../../../auto-reply/reply/dispatch-native-subagent.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  nativeSubagentRuntime,
  withNativeSubagentRuntimeGuard,
} from "../../../plugins/runtime/native-subagent-context.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
  type AdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { enqueueSwarmRun, holdQueuedSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { registerNativePluginRewriteCases } from "./subagent-spawn.plugin-native-rewrite.test-support.js";
import { registerNativePluginSandboxCases } from "./subagent-spawn.plugin-native-sandbox.test-support.js";
import {
  createSpawnOperatorSource,
  recordSpawnBoundaryFinal,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;

export type NativePluginSpawnTestOptions = {
  createBoundParent: (
    authority?: AdmittedRunOperatorAuthority,
    settings?: { guestProfileId?: string },
  ) => Promise<BoundParent>;
  createBoundGateway: (
    bound: BoundParent,
  ) => Promise<{ context: GatewayRequestContext; runtime: GatewayRuntime }>;
  closeBoundGateway: (
    bound: BoundParent,
    runtime: GatewayRuntime,
    childRunId?: string,
  ) => Promise<unknown[]>;
  waitForEmbeddedRun: (
    bound: BoundParent,
    runId: string,
    started?: Promise<void>,
    calls?: number,
  ) => Promise<void>;
  settleRootWork: (keepObserving?: boolean) => Promise<void>;
  throwBoundFailures: (failures: unknown[]) => void;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
};

export function registerNativePluginSpawnCases(options: NativePluginSpawnTestOptions) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    waitForEmbeddedRun,
    settleRootWork,
    throwBoundFailures,
    runEmbeddedAgent,
  } = options;
  registerNativePluginRewriteCases(options);
  registerNativePluginSandboxCases(options);
  it("native plugin facade keeps native IDs, exact overrides, parent custody and requester policy", async () => {
    const source = createSpawnOperatorSource();
    const bound = await createBoundParent(source.authority);
    const { parentSessionKey, parentRunId } = bound;
    const { context, runtime } = await createBoundGateway(bound);
    const capacityStarted = createDeferred();
    enqueueSwarmRun({
      groupId: JSON.stringify([
        "main",
        parentSessionKey,
        `swarm:${parentSessionKey}:${parentRunId}`,
      ]),
      runId: "plugin-capacity",
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        capacityStarted.resolve();
      },
      onStartFailure: () => true,
    });
    await capacityStarted.promise;
    const failures: unknown[] = [];
    let childRunId: string | undefined;
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        async () => {
          const { createRequestNativeSubagentRuntime } =
            await import("../../plugin-native-subagent.js");
          const makeNative = (pluginId = "native-test", sessionId = "parent-session") =>
            createRequestNativeSubagentRuntime(
              {
                options: {
                  config: bound.cfg,
                  agentId: "main",
                  sessionKey: parentSessionKey,
                  sessionId,
                  runId: parentRunId,
                  workspaceDir: resolveAgentWorkspaceDir(bound.cfg, "main"),
                  senderIsOwner: true,
                  allowGatewaySubagentBinding: true,
                  runtimeToolAllowlist: ["sessions_spawn", "agents_wait", "read"],
                  inheritRuntimeToolAllowlist: true,
                },
                operatorAuthority: source.authority,
                assertCurrent: source.authority.assertCurrent,
                async prepareSpawn(assertCurrent) {
                  assertCurrent();
                  return bound.admitted;
                },
              },
              { pluginId, assertCurrent: source.authority.assertCurrent },
            );
          const native = makeNative();
          const request = {
            requestId: "review",
            task: "Review the implementation",
            model: "custom/test-model",
            thinking: "high",
            fastMode: "ultrafast" as const,
            context: "isolated" as const,
          };
          let entered = createDeferred();
          let release = createDeferred();
          const beforeSpawn = vi.fn(async (event: { toolName: string }) => {
            if (event.toolName === "sessions_spawn") {
              entered.resolve();
              await release.promise;
            }
          });
          const hooks = createMockPluginRegistry([]);
          addTestHook({
            registry: hooks,
            pluginId: "test-plugin",
            hookName: "before_tool_call",
            handler: beforeSpawn,
          });
          initializeGlobalHookRunner(hooks);
          const pending = Promise.allSettled([
            native.spawn(request),
            native.spawn(request),
            native.spawn({ ...request, task: "different in-flight task" }),
          ]);
          await entered.promise;
          expect(subagentRuns.size).toBe(0);
          release.resolve();
          const settled = await pending;
          expect(settled[2]).toMatchObject({
            status: "rejected",
            reason: expect.objectContaining({
              message: "Native subagent replay does not match the admitted request.",
            }),
          });
          const launches = settled.slice(0, 2);
          const first = expectDefined(
            launches.find((result) => result.status === "fulfilled"),
            "accepted native launch",
          );
          if (first.status !== "fulfilled") {
            throw new Error("No native launch accepted");
          }
          const accepted = first.value;
          childRunId = accepted.runId;
          expect(launches).toEqual([
            { status: "fulfilled", value: accepted },
            { status: "fulfilled", value: accepted },
          ]);
          expect(subagentRuns.size).toBe(1);
          expect(beforeSpawn).toHaveBeenCalledTimes(1);
          expect(accepted).toEqual({
            runId: expect.any(String),
            childSessionKey: expect.any(String),
            completionMode: "collect",
          });
          expect(await native.spawn(request)).toEqual(accepted);
          await expect(native.spawn({ ...request, task: "different task" })).rejects.toThrow();
          const entry = loadSessionEntry({
            storePath: bound.storePath,
            sessionKey: accepted.childSessionKey,
          });
          expect(entry).toMatchObject({
            spawnedBy: parentSessionKey,
            spawnDepth: 2,
            modelOverride: "test-model",
            providerOverride: "custom",
            thinkingLevel: "high",
            fastMode: "ultrafast",
            inheritedToolAllow: expect.arrayContaining(["read"]),
          });
          expect(subagentRuns.get(childRunId)).toMatchObject({
            requesterTurnRunId: parentRunId,
            completionRequesterSessionId: "parent-session",
            collect: true,
            execution: { status: "queued" },
          });
          expect(await native.collect({ ids: [childRunId], timeoutSeconds: 0 })).toMatchObject({
            completed: [],
            pending: [childRunId],
          });
          // Same replay input in another plugin has independent native custody.
          const sibling = await makeNative("another-plugin").spawn(request);
          expect(sibling.runId).not.toBe(accepted.runId);
          expect(subagentRuns.size).toBe(2);
          const otherRequester = makeNative("native-test", "different-parent-incarnation");
          expect(
            await otherRequester.collect({ ids: [childRunId], timeoutSeconds: 0 }),
          ).toMatchObject({
            errors: [{ runId: childRunId, error: "not_owner" }],
            completed: [],
            pending: [],
          });
          // A matching join cannot outlive the source while the finalized spawn hook awaits.
          entered = createDeferred();
          release = createDeferred();
          const revokedRequest = { ...request, requestId: "revoked-in-flight" };
          const revoked = Promise.allSettled([
            native.spawn(revokedRequest),
            native.spawn(revokedRequest),
          ]);
          await entered.promise;
          source.revoke();
          release.resolve();
          expect(await revoked).toEqual([
            {
              status: "rejected",
              reason: expect.objectContaining({ message: "operator source revoked" }),
            },
            {
              status: "rejected",
              reason: expect.objectContaining({ message: "operator source revoked" }),
            },
          ]);
          expect(subagentRuns.size).toBe(2);
          bound.admission.close();
          bound.parent.cleanup();
          source.closeRequest();
          for (const id of [childRunId, sibling.runId]) {
            const queued = holdQueuedSwarmRun(id);
            if (queued) {
              await queued.release();
            }
          }
          await expect(native.spawn({ ...request, requestId: "retired" })).rejects.toThrow(
            "operator source revoked",
          );
        },
      );
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    } catch (error) {
      failures.push(error);
    } finally {
      resetGlobalHookRunner();
      const queued = childRunId ? holdQueuedSwarmRun(childRunId) : undefined;
      bound.admission.close();
      bound.parent.cleanup();
      source.closeRequest();
      source.revoke();
      await queued?.release();
      releaseSwarmRun("plugin-capacity");
      failures.push(...(await closeBoundGateway(bound, runtime, childRunId)));
      throwBoundFailures(failures);
    }
  });

  it.each([
    { name: "default scopes", scopes: undefined },
    { name: "explicit empty scopes", scopes: [] },
  ])(
    "native plugin facade adopts input and preserves authority after the hook exits ($name)",
    async ({ scopes }) => {
      const source = createSpawnOperatorSource("spawn-operator", scopes);
      const bound = await createBoundParent(source.authority);
      const { parentSessionKey, parentRunId } = bound;
      const { context, runtime } = await createBoundGateway(bound);
      const entry = expectDefined(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: parentSessionKey }),
        "parent session",
      );
      const capacityStarted = createDeferred();
      enqueueSwarmRun({
        groupId: JSON.stringify([
          "main",
          parentSessionKey,
          `swarm:${parentSessionKey}:${parentRunId}`,
        ]),
        runId: "host-capacity",
        maxConcurrent: 1,
        activeRunIds: [],
        start: async () => {
          capacityStarted.resolve();
        },
        onStartFailure: () => true,
      });
      await capacityStarted.promise;
      const modelStarted = createDeferred();
      const finishModel = createDeferred();
      runEmbeddedAgent.mockImplementationOnce(async (params) => {
        const admitted = await resolvePreparedRunAdmission({
          runId: params.runId,
          runtimeKind: "embedded",
          admittedRunContext: params.admittedRunContext,
          preparedRunAdmission: params.preparedRunAdmission,
        });
        const authority = readAdmittedRunOperatorAuthority(admitted);
        expect(authority?.profileId).toBe(source.authority.profileId);
        expect(authority?.scopes).toEqual(source.authority.scopes);
        modelStarted.resolve();
        await finishModel.promise;
        await recordSpawnBoundaryFinal({
          storePath: bound.storePath,
          sessionKey: expectDefined(params.sessionKey, "child session"),
          runId: params.runId,
          text: "host child complete",
        });
        return {
          payloads: [{ text: "host child complete" }],
          meta: {
            durationMs: 1,
            terminalReply: { disposition: "visible", text: "host child complete" },
          },
        };
      });
      let adopted = false;
      const adopt = vi.fn(async () => {
        adopted = true;
      });
      const transcript = () =>
        loadTranscriptEvents({
          agentId: "main",
          storePath: bound.storePath,
          sessionKey: parentSessionKey,
          sessionId: entry.sessionId,
        });
      let childRunId: string | undefined;
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "The actual finalized input" },
        target: {
          agentId: "main",
          sessionKey: parentSessionKey,
          sessionId: entry.sessionId,
          sessionEntry: entry,
          storePath: bound.storePath,
          config: bound.cfg,
        },
        assertOriginalInputCommit: () => {
          expect(adopted).toBe(true);
        },
      });
      const inReply = (
        requestSource: ReturnType<typeof createSpawnOperatorSource>,
        turnRunId: string,
        run: () => Promise<void>,
        withOperatorAuthority = true,
      ) =>
        withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
          runWithReplyNativeSubagents(
            {
              cfg: bound.cfg,
              ctx: buildTestCtx({
                Body: "The actual finalized input",
                SessionKey: parentSessionKey,
                CommandAuthorized: true,
              }),
              params: {
                replyOptions: {
                  runId: turnRunId,
                  operatorAuthority: withOperatorAuthority ? requestSource.authority : undefined,
                  toolsAllow: ["sessions_spawn", "agents_wait", "read"],
                  userTurnTranscriptRecorder: recorder,
                },
              },
              sessionAgentId: "main",
              sessionKey: parentSessionKey,
              sessionStoreEntry: { sessionKey: parentSessionKey, entry },
              getPreDispatchAbortSignal: () => undefined,
              assertProgressCurrent: requestSource.authority.assertCurrent,
              assertCurrentBindingRoute: async () => {
                requestSource.authority.assertCurrent();
              },
              turnAdoption: {
                assertCurrent: requestSource.authority.assertCurrent,
                adopt,
              },
            },
            () =>
              withNativeSubagentRuntimeGuard(
                { pluginId: "native-test", assertCurrent: requestSource.authority.assertCurrent },
                run,
              ),
          ),
        );
      const failures: unknown[] = [];
      try {
        await expect(
          inReply(
            source,
            parentRunId,
            async () => {
              await nativeSubagentRuntime.spawn({ requestId: "no-authority", task: "Must refuse" });
            },
            false,
          ),
        ).rejects.toThrow("admitted requester session, turn, and operator authority");
        expect(adopted).toBe(false);
        expect(adopt).not.toHaveBeenCalled();
        expect(await transcript()).toEqual([]);
        expect(subagentRuns.size).toBe(0);
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        await inReply(source, parentRunId, async () => {
          const request = {
            requestId: "host-review",
            task: "Review host input",
            context: "isolated" as const,
          };
          const [child, replay] = await Promise.all([
            nativeSubagentRuntime.spawn(request),
            nativeSubagentRuntime.spawn(request),
          ]);
          expect(replay).toEqual(child);
          childRunId = child.runId;
          expect(recorder.getAdmissionReceipt()).toMatchObject({
            sessionId: entry.sessionId,
            sessionKey: parentSessionKey,
            agentId: "main",
          });
          expect(child.completionMode).toBe("collect");
          expect(subagentRuns.get(childRunId)?.execution.status).toBe("queued");
        });
        expect(adopt).toHaveBeenCalledTimes(1);
        expect(await transcript()).toEqual([
          expect.objectContaining({ type: "session", id: entry.sessionId }),
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "The actual finalized input",
            }),
          }),
        ]);
        bound.admission.close();
        bound.parent.cleanup();
        source.closeRequest();
        expect(source.holds).toBeGreaterThan(0);
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        releaseSwarmRun("host-capacity");
        if (scopes?.length === 0) {
          await vi.waitFor(() =>
            expect(
              subagentRuns.get(expectDefined(childRunId, "accepted child run"))?.collectorCompletion
                ?.status,
            ).toBe("failed"),
          );
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
          // The queued native launch reaches the real Gateway, which must keep [] exact.
          await expect(settleRootWork(true)).rejects.toMatchObject({
            errors: expect.arrayContaining([
              expect.objectContaining({
                code: "FORBIDDEN",
                details: expect.objectContaining({
                  code: "MISSING_SCOPE",
                  missingScope: "operator.write",
                }),
              }),
            ]),
          });
          return;
        }
        await waitForEmbeddedRun(
          bound,
          expectDefined(childRunId, "accepted child run"),
          modelStarted.promise,
        );
        expect(
          subagentRuns.get(expectDefined(childRunId, "accepted child run"))?.execution.status,
        ).toBe("running");
        finishModel.resolve();
        await vi.waitFor(() =>
          expect(
            subagentRuns.get(expectDefined(childRunId, "accepted child run"))?.collectorCompletion
              ?.status,
          ).toBe("done"),
        );
        const nextSource = createSpawnOperatorSource();
        try {
          await inReply(nextSource, "followup-run", async () => {
            const beforeToolCall = vi.fn(async () => ({
              block: true,
              blockReason: "collector denied",
            }));
            initializeGlobalHookRunner(
              createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
            );
            try {
              const [ordinaryWait] = finalizeAgentTools({
                tools: [
                  createAgentsWaitTool({
                    config: bound.cfg,
                    agentId: "main",
                    agentSessionKey: parentSessionKey,
                  }),
                ],
                hookContext: {
                  config: bound.cfg,
                  agentId: "main",
                  sessionKey: parentSessionKey,
                  runId: "followup-run",
                },
              });
              await expect(
                expectDefined(ordinaryWait, "finalized wait tool").execute("ordinary-wait", {
                  ids: [childRunId],
                  timeoutSeconds: 0,
                }),
              ).resolves.toMatchObject({
                details: { status: "blocked", reason: "collector denied" },
              });
              await expect(
                nativeSubagentRuntime.collect({
                  ids: [expectDefined(childRunId, "accepted child run")],
                  timeoutSeconds: 0,
                }),
              ).rejects.toThrow("collector denied");
              expect(beforeToolCall).toHaveBeenCalledTimes(2);
            } finally {
              resetGlobalHookRunner();
            }
            const result = await nativeSubagentRuntime.collect({
              ids: [expectDefined(childRunId, "accepted child run")],
              awaitResults: true,
            });
            expect(result).toMatchObject({
              completed: [{ runId: childRunId, status: "done", result: "host child complete" }],
              pending: [],
            });
          });
        } finally {
          nextSource.closeRequest();
        }
      } catch (error) {
        failures.push(error);
      } finally {
        releaseSwarmRun("host-capacity");
        finishModel.resolve();
        failures.push(...(await closeBoundGateway(bound, runtime, childRunId)));
        throwBoundFailures(failures);
      }
    },
  );

  it("native plugin facade refuses a denied spawn before preparing or creating a child", async () => {
    const source = createSpawnOperatorSource();
    const bound = await createBoundParent(source.authority);
    const { parentSessionKey, parentRunId } = bound;
    const { context, runtime } = await createBoundGateway(bound);
    const failures: unknown[] = [];
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        async () => {
          const { createRequestNativeSubagentRuntime } =
            await import("../../plugin-native-subagent.js");
          const prepareSpawn = vi.fn(async () => bound.admitted);
          const native = createRequestNativeSubagentRuntime(
            {
              options: {
                config: bound.cfg,
                agentId: "main",
                sessionKey: parentSessionKey,
                sessionId: "parent-session",
                runId: parentRunId,
                workspaceDir: resolveAgentWorkspaceDir(bound.cfg, "main"),
                senderIsOwner: true,
                runtimeToolAllowlist: ["read"],
                inheritRuntimeToolAllowlist: true,
              },
              operatorAuthority: source.authority,
              assertCurrent: source.authority.assertCurrent,
              prepareSpawn,
            },
            { pluginId: "native-test", assertCurrent: source.authority.assertCurrent },
          );
          await expect(
            native.collect({ ids: ["not-readable"], timeoutSeconds: 0 }),
          ).rejects.toThrow("agents_wait is not available");
          await expect(native.spawn({ requestId: "denied", task: "Do not run" })).rejects.toThrow(
            "sessions_spawn is not available",
          );
          expect(prepareSpawn).not.toHaveBeenCalled();
          expect(subagentRuns.size).toBe(0);
          expect(runEmbeddedAgent).not.toHaveBeenCalled();
        },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      failures.push(...(await closeBoundGateway(bound, runtime)));
      throwBoundFailures(failures);
    }
  });
}
