import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { nativeSubagentRuntime } from "../../../plugins/runtime/native-subagent-context.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  readAdmittedRunOperatorAuthority,
  resolvePreparedRunAdmission,
} from "../../admitted-run-context.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import * as subagentSessionReconciliation from "../registry/subagent-session-reconciliation.js";
import { holdQueuedSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { visibleResult } from "./subagent-spawn.fixtures.test-support.js";
import { registerNativePluginCommandCases } from "./subagent-spawn.plugin-command.test-support.js";
import {
  holdNativeCapacity,
  installNativeToolHook,
  nativeReplyFixture,
  nativeRequestSource,
  registerNativePluginRewriteCases,
} from "./subagent-spawn.plugin-native-rewrite.test-support.js";
import {
  createSpawnOperatorSource,
  recordSpawnBoundaryFinal,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

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
  registerNativePluginCommandCases(options);
  registerNativePluginRewriteCases(options);
  registerNativePluginSandboxCases(options);
  it("native plugin facade keeps native IDs, exact overrides, parent custody and requester policy", async () => {
    const source = createSpawnOperatorSource();
    const bound = await createBoundParent(source.authority);
    const { parentSessionKey, parentRunId } = bound;
    const { context, runtime } = await createBoundGateway(bound);
    await holdNativeCapacity(bound, "plugin-capacity");
    const failures: unknown[] = [];
    let childRunId: string | undefined;
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, isWebchatConnect: () => false },
        async () => {
          const { createRequestNativeSubagentRuntime } =
            await import("../../plugin-native-subagent.js");
          const makeNative = (
            pluginId = "native-test",
            sessionId = "parent-session",
            abortSignal?: AbortSignal,
          ) =>
            createRequestNativeSubagentRuntime(
              nativeRequestSource(bound, source, { sessionId, abortSignal }),
              { pluginId, assertCurrent: source.authority.assertCurrent },
            );
          const native = makeNative();
          const request = {
            requestId: "review",
            task: "Review the implementation",
            model: "custom/requested-model",
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
              return { params: { model: "custom/test-model", thinking: "low", fastMode: false } };
            }
            return undefined;
          });
          installNativeToolHook("test-plugin", beforeSpawn);
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
            selection: {
              requested: {
                model: "custom/requested-model",
                thinking: "high",
                fastMode: "ultrafast",
              },
              resolved: { model: "custom/test-model", thinking: "low", fastMode: false },
            },
          });
          expect(await native.spawn(request)).toEqual(accepted);
          const unreadableChild = vi
            .spyOn(subagentSessionReconciliation, "loadSubagentSessionEntry")
            .mockRejectedValueOnce(new Error("child metadata unavailable"));
          try {
            expect((await native.spawn(request)).selection).toEqual({
              requested: {
                model: "custom/requested-model",
                thinking: "high",
                fastMode: "ultrafast",
              },
            });
          } finally {
            unreadableChild.mockRestore();
          }
          const closing = new AbortController();
          const closingNative = makeNative("native-test", "parent-session", closing.signal);
          const metadataEntered = createDeferred();
          const releaseMetadata = createDeferred();
          const closingMetadata = vi
            .spyOn(subagentSessionReconciliation, "loadSubagentSessionEntry")
            .mockImplementationOnce(async () => {
              metadataEntered.resolve();
              await releaseMetadata.promise;
              closing.abort(new Error("invocation closed during optional metadata read"));
              throw closing.signal.reason;
            });
          try {
            const closingSpawns = Promise.all([
              closingNative.spawn(request),
              closingNative.spawn(request),
            ]);
            await metadataEntered.promise;
            releaseMetadata.resolve();
            // Acceptance stays addressable to both callers when optional metadata closes.
            const receipts = await closingSpawns;
            expect(receipts).toEqual([receipts[0], receipts[0]]);
            expect(receipts[0]).toMatchObject({
              runId: accepted.runId,
              childSessionKey: accepted.childSessionKey,
              selection: { requested: accepted.selection?.requested },
            });
            expect(closingMetadata).toHaveBeenCalledTimes(1);
            await expect(closingNative.spawn(request)).rejects.toThrow("invocation closed");
          } finally {
            closingMetadata.mockRestore();
          }
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
            thinkingLevel: "low",
            fastMode: false,
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
          const refusal = {
            status: "rejected",
            reason: expect.objectContaining({ message: "operator source revoked" }),
          };
          expect(await revoked).toEqual([refusal, refusal]);
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
      await holdNativeCapacity(bound, "host-capacity");
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
        return visibleResult("host child complete");
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
      const inReply = nativeReplyFixture(
        bound,
        context,
        entry,
        recorder,
        "The actual finalized input",
        adopt,
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
            fastMode: false,
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
        const acceptedRunId = expectDefined(childRunId, "accepted child run");
        const completion = () => subagentRuns.get(acceptedRunId)?.collectorCompletion?.status;
        releaseSwarmRun("host-capacity");
        if (scopes?.length === 0) {
          await vi.waitFor(() => expect(completion()).toBe("failed"));
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
        await waitForEmbeddedRun(bound, acceptedRunId, modelStarted.promise);
        expect(subagentRuns.get(acceptedRunId)?.execution.status).toBe("running");
        finishModel.resolve();
        await vi.waitFor(() => expect(completion()).toBe("done"));
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
                  ids: [acceptedRunId],
                  timeoutSeconds: 0,
                }),
              ).rejects.toThrow("collector denied");
              expect(beforeToolCall).toHaveBeenCalledTimes(2);
            } finally {
              resetGlobalHookRunner();
            }
            const result = await nativeSubagentRuntime.collect({
              ids: [acceptedRunId],
              awaitResults: true,
            });
            expect(result.completed[0]?.selection).toEqual({
              requested: {},
              resolved: { model: "custom/test-model", fastMode: false },
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
              ...nativeRequestSource(bound, source, {
                runtimeToolAllowlist: ["read"],
                allowGatewaySubagentBinding: undefined,
              }),
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

function registerNativePluginSandboxCases(options: NativePluginSpawnTestOptions) {
  it.each([
    { tool: "sessions_spawn", required: false },
    { tool: "agents_wait", required: false },
    { tool: "sessions_spawn", required: true },
    { tool: "agents_wait", required: true },
  ] as const)(
    "reply native facade enforces sandbox policy for $tool before effects (required=$required)",
    async ({ tool, required }) => {
      const source = createSpawnOperatorSource();
      const bound = await options.createBoundParent(
        source.authority,
        required ? { guestProfileId: source.authority.profileId } : undefined,
      );
      bound.cfg.agents!.defaults!.sandbox = { mode: "off" };
      bound.cfg.tools!.sandbox = {
        tools: { allow: ["sessions_spawn", "agents_wait"] },
      };
      const { parentSessionKey, parentRunId } = bound;
      const { context, runtime } = await options.createBoundGateway(bound);
      const acceptedIds: string[] = [];
      const failures: unknown[] = [];
      const adopt = vi.fn(async () => {});
      const initialEntry = expectDefined(
        loadSessionEntry({ storePath: bound.storePath, sessionKey: parentSessionKey }),
        "requester entry",
      );
      expect(initialEntry.sandbox).toBe(required ? "required" : undefined);
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "sandbox requester input" },
        target: {
          agentId: "main",
          sessionKey: parentSessionKey,
          sessionId: initialEntry.sessionId,
          sessionEntry: initialEntry,
          storePath: bound.storePath,
          config: bound.cfg,
        },
      });
      const inReply = (run: () => Promise<void>) =>
        nativeReplyFixture(
          bound,
          context,
          expectDefined(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: parentSessionKey }),
            "requester entry",
          ),
          recorder,
          "sandbox requester input",
          adopt,
          ["sessions_spawn", "agents_wait"],
        )(source, parentRunId, run);
      const transcript = () =>
        loadTranscriptEvents({
          agentId: "main",
          storePath: bound.storePath,
          sessionKey: parentSessionKey,
          sessionId: initialEntry.sessionId,
        });
      let childRunId: string | undefined;
      const capacity = "sandbox-capacity";
      try {
        if (tool === "sessions_spawn") {
          await holdNativeCapacity(bound, capacity);
        } else {
          options.runEmbeddedAgent.mockImplementationOnce(async (params) => {
            await recordSpawnBoundaryFinal({
              storePath: bound.storePath,
              sessionKey: expectDefined(params.sessionKey, "child session"),
              runId: params.runId,
              text: "private child result",
            });
            return visibleResult("private child result");
          });
          await inReply(async () => {
            const child = await nativeSubagentRuntime.spawn({
              requestId: "initial",
              task: "produce result",
              context: "isolated",
            });
            childRunId = child.runId;
            acceptedIds.push(child.runId);
          });
          await options.waitForEmbeddedRun(bound, expectDefined(childRunId, "child run"));
          await vi.waitFor(() =>
            expect(
              subagentRuns.get(expectDefined(childRunId, "child run"))?.collectorCompletion?.status,
            ).toBe("done"),
          );
        }
        const invoke = async (requestId: string) => {
          if (tool === "sessions_spawn") {
            const child = await nativeSubagentRuntime.spawn({
              requestId,
              task: "sandbox child",
              context: "isolated",
            });
            acceptedIds.push(child.runId);
            return child;
          }
          return nativeSubagentRuntime.collect({
            ids: [expectDefined(childRunId, "completed child")],
            timeoutSeconds: 0,
          });
        };
        const scenarios = required
          ? ([
              { mode: "off", deny: true, blocked: true },
              { mode: "off", deny: false, blocked: false },
            ] as const)
          : ([
              { mode: "all", deny: true, blocked: true },
              { mode: "off", deny: true, blocked: false },
              { mode: "all", deny: false, blocked: false },
            ] as const);
        for (const scenario of scenarios) {
          bound.cfg.agents!.defaults!.sandbox = { mode: scenario.mode };
          bound.cfg.tools!.sandbox = {
            tools: { allow: ["sessions_spawn", "agents_wait"], deny: scenario.deny ? [tool] : [] },
          };
          const before = {
            ids: [...subagentRuns.keys()],
            transcript: await transcript(),
            adoption: adopt.mock.calls.length,
            model: options.runEmbeddedAgent.mock.calls.length,
          };
          await inReply(async () => {
            const requestId = [scenario.mode, scenario.deny].join("-");
            if (scenario.blocked) {
              await expect(invoke(requestId)).rejects.toThrow(tool + " is not available");
            } else {
              const result = await invoke(requestId);
              if (tool === "sessions_spawn") {
                expect(result).toMatchObject({ completionMode: "collect" });
              } else {
                expect(result).toMatchObject({
                  completed: [
                    { runId: childRunId, status: "done", result: "private child result" },
                  ],
                  pending: [],
                });
              }
            }
          });
          if (scenario.blocked) {
            expect([...subagentRuns.keys()]).toEqual(before.ids);
            expect(await transcript()).toEqual(before.transcript);
            expect(adopt).toHaveBeenCalledTimes(before.adoption);
            expect(options.runEmbeddedAgent).toHaveBeenCalledTimes(before.model);
          }
        }
      } catch (error) {
        failures.push(error);
      } finally {
        for (const id of acceptedIds) {
          const queued = holdQueuedSwarmRun(id);
          queued?.withdraw();
          await queued?.release();
        }
        releaseSwarmRun(capacity);
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        source.closeRequest();
        options.throwBoundFailures(failures);
      }
    },
  );
}
