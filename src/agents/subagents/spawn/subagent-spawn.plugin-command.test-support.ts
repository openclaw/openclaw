import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { tryFastAbortFromMessage } from "../../../auto-reply/reply/abort.js";
import { handlePluginCommand } from "../../../auto-reply/reply/commands-plugin.js";
import { buildCommandTestParams } from "../../../auto-reply/reply/commands.test-harness.js";
import { runWithCommandNativeSubagents } from "../../../auto-reply/reply/dispatch-native-subagent.js";
import { buildTestCtx } from "../../../auto-reply/reply/test-ctx.js";
import {
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
} from "../../../config/sessions/session-accessor.js";
import { createOwnershipRecord } from "../../../plugins/registry-ownership.test-support.js";
import { createTestPluginRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import type { NativeSubagentRuntime } from "../../../plugins/runtime/types-native-subagent.js";
import type { PluginCommandContext } from "../../../plugins/types.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { sessionReader } from "./subagent-spawn.fixtures.test-support.js";
import {
  createSpawnTranscriptTarget,
  createSpawnOperatorSource,
  holdSpawnCapacity,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

/** Command dispatch must commit the actual user input before handing native authority to a plugin. */
export function registerNativePluginCommandCases(options: NativePluginSpawnTestOptions) {
  const stopCase = it.for(["after settlement", "during collect"] as const);
  stopCase("native command /stop %s", async (stopTiming, { signal }) => {
    const source = createSpawnOperatorSource();
    const bound = await options.createBoundParent(source.authority);
    const { context, runtime } = await options.createBoundGateway(bound);
    const { parentSessionKey, parentRunId } = bound;
    const readSession = sessionReader(bound.storePath);
    const workspaceDir = resolveAgentWorkspaceDir(bound.cfg, "main");
    const builder = createTestPluginRegistry();
    const record = createOwnershipRecord("command-controller", {
      contracts: { commandRuntimeCapabilities: ["subagents"] },
    });
    const failures: unknown[] = [];
    const collectStarted = createDeferred();
    let collectFailure: unknown;
    let collectSettled = false;
    const capacityStarted = holdSpawnCapacity(
      JSON.stringify(["main", parentSessionKey, "swarm:" + parentSessionKey + ":" + parentRunId]),
      "command-capacity",
    );
    let childRunId: string | undefined;
    let retained: NativeSubagentRuntime | undefined;
    let commandRun = 0;
    let activeSignal: AbortSignal | undefined = bound.parent.controller.signal;
    const closedSpawn = (requestId: string) =>
      expect(
        expectDefined(retained, "retained runtime").spawn({ requestId, task: "Must not run" }),
      ).rejects.toSatisfy((error: unknown) => String(error).includes("command invocation closed"));
    const handler = vi.fn(async (ctx: PluginCommandContext) => {
      const native = expectDefined(ctx.runtimeContext?.subagents, "host command capability");
      retained = native;
      expect(Reflect.has(native, "prepareCommand")).toBe(false);
      const entry = expectDefined(readSession(parentSessionKey), "current requester");
      const events = await loadTranscriptEvents({
        agentId: "main",
        storePath: bound.storePath,
        sessionKey: parentSessionKey,
        sessionId: entry.sessionId,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user", content: "/pstack-review" }),
        }),
      );
      if (commandRun === 1) {
        const child = await native.spawn({
          requestId: "review",
          task: "Review the current user request",
          model: "custom/test-model",
          context: "isolated",
        });
        childRunId = child.runId;
        const actual = expectDefined(readSession(child.childSessionKey), "native child");
        expect(child.selection?.requested.model).toBe("custom/test-model");
        expect(child.selection?.resolved?.model).toBe("custom/test-model");
        expect(child.selection?.resolved?.model).toBe(actual.modelProvider + "/" + actual.model);
        expect(actual.spawnedBy).toBe(parentSessionKey);
        expect(actual.inheritedToolAllow).toEqual(expect.arrayContaining(["read"]));
        expect(subagentRuns.get(child.runId)).toMatchObject({
          requesterTurnRunId: parentRunId,
          collect: true,
          execution: { status: "queued" },
        });
        expect(await native.collect({ ids: [child.runId], timeoutSeconds: 0 })).toMatchObject({
          completed: [],
          pending: [child.runId],
        });
        if (stopTiming === "during collect") {
          const collecting = native.collect({ ids: [child.runId], timeoutSeconds: 30 });
          collectStarted.resolve();
          try {
            await collecting;
            return { text: "review wait completed", continueAgent: true };
          } catch (error) {
            collectFailure = error;
            return { text: "review aborted" };
          } finally {
            collectSettled = true;
          }
        }
        return { text: "review queued" };
      }
      expect(
        await native.collect({
          ids: [expectDefined(childRunId, "accepted run")],
          timeoutSeconds: 0,
        }),
      ).toMatchObject({
        errors: [{ runId: childRunId, error: "not_owner" }],
        completed: [],
        pending: [],
      });
      return { text: "old child refused" };
    });
    // The actual registrar reads the manifest record before loader publication.
    const api = builder.createApi(record, { config: bound.cfg });
    api.registerCommand({
      name: "pstack-review",
      description: "Review with native helpers",
      requireAuth: true,
      runtimeCapabilities: ["subagents"],
      handler,
    });
    builder.registry.plugins.push(record);
    const invokeCommand = async () => {
      commandRun += 1;
      const entry = expectDefined(readSession(parentSessionKey), "requester session");
      const ctx = buildTestCtx({
        Body: "/pstack-review",
        CommandBody: "/pstack-review",
        CommandAuthorized: true,
        SessionKey: parentSessionKey,
        InputProvenance: { kind: "external_user" },
      });
      const adopt = vi.fn(async () => {});
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "/pstack-review" },
        target: createSpawnTranscriptTarget(bound, entry),
        assertOriginalInputCommit: () => {
          expect(adopt).toHaveBeenCalled();
        },
      });
      const state: Parameters<typeof runWithCommandNativeSubagents>[0] = {
        cfg: bound.cfg,
        ctx,
        sessionAgentId: "main",
        sessionKey: parentSessionKey,
        sessionStoreEntry: { sessionKey: parentSessionKey, entry },
        params: {
          replyOptions: {
            runId: commandRun === 1 ? parentRunId : "reset-command",
            operatorAuthority: source.authority,
            toolsAllow: ["sessions_spawn", "agents_wait", "read"],
            userTurnTranscriptRecorder: recorder,
          },
        },
        getPreDispatchAbortSignal: () => undefined,
        getDispatchAbortSignal: () => activeSignal,
        assertProgressCurrent: source.authority.assertCurrent,
        assertCurrentBindingRoute: async () => {
          source.authority.assertCurrent();
        },
        turnAdoption: { assertCurrent: source.authority.assertCurrent, adopt },
      };
      const params = buildCommandTestParams("/pstack-review", bound.cfg, ctx, { workspaceDir });
      params.sessionKey = parentSessionKey;
      params.sessionEntry = entry;
      params.storePath = bound.storePath;
      params.opts = {
        withCommandNativeSubagents: (binding, run) =>
          runWithCommandNativeSubagents(state, binding, run),
      };
      const reply = await handlePluginCommand(params, true);
      expect(recorder.getAdmissionReceipt()).toMatchObject({
        sessionId: entry.sessionId,
        sessionKey: parentSessionKey,
        agentId: "main",
      });
      return reply;
    };
    const invoke = () => {
      if (commandRun !== 0) {
        return invokeCommand();
      }
      if (!bound.parent.registered) {
        throw new Error("Command fixture requires its own requester source");
      }
      // A running command owns an admitted turn, not just a reserved RPC source.
      return withSessionTurn(
        {
          sessionKey: parentSessionKey,
          sessionId: "parent-session",
          agentId: "main",
          storePath: bound.storePath,
          controllerInput: bound.parent.entry.input,
        },
        async (_operation, ownerSignal) => {
          activeSignal = AbortSignal.any([bound.parent.controller.signal, ownerSignal]);
          return await invokeCommand();
        },
      );
    };
    try {
      await capacityStarted;
      await withPluginRuntimeGatewayRequestScope(
        {
          context,
          pluginRegistry: builder.registry,
          resolveGatewayContext: bound.resolveGatewayContext,
          isWebchatConnect: () => false,
        },
        async () => {
          const command = invoke();
          if (stopTiming === "during collect") {
            await withinTest(
              awaitGateBeforeSettlement(
                collectStarted.promise,
                command,
                "command settled before reaching its in-flight collect",
              ),
              signal,
            );
            expect(collectSettled).toBe(false);
            expect(bound.parent.controller.signal.aborted).toBe(false);
          } else {
            expect(await command).toEqual({
              shouldContinue: false,
              reply: { text: "review queued" },
            });
            await closedSpawn("late");
          }
          const stopStartedAt = performance.now();
          const stop = await tryFastAbortFromMessage({
            cfg: bound.cfg,
            ctx: buildTestCtx({
              Body: "/stop",
              CommandBody: "/stop",
              SessionKey: parentSessionKey,
              CommandAuthorized: true,
            }),
          });
          expect(stop).toMatchObject({ handled: true, stoppedSubagents: 1, failedSubagents: 0 });
          if (stopTiming === "during collect") {
            expect(stop.aborted).toBe(true);
            expect(bound.parent.controller.signal.aborted).toBe(true);
            expect(await withinTest(command, signal)).toEqual({
              shouldContinue: false,
              reply: { text: "review aborted" },
            });
            // Cancellation must settle the 30-second wait, not wait for its deadline.
            expect(performance.now() - stopStartedAt).toBeLessThan(10_000);
            expect(collectSettled).toBe(true);
            expect(collectFailure).toMatchObject({ name: "AbortError" });
            expect(await handler.mock.results[0]?.value).not.toHaveProperty("continueAgent");
            const acceptedRunIds = [...subagentRuns.keys()];
            await closedSpawn("late-after-stop");
            expect([...subagentRuns.keys()]).toEqual(acceptedRunIds);
          }
          expect(
            subagentRuns.get(expectDefined(childRunId, "stopped child"))?.collectorCompletion
              ?.status,
          ).toBe("killed");
          expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
          if (stopTiming === "during collect") {
            return;
          }
          const before = expectDefined(readSession(parentSessionKey), "before reset");
          const reset = await resetSessionEntryLifecycle({
            agentId: "main",
            storePath: bound.storePath,
            target: { canonicalKey: parentSessionKey, storeKeys: [parentSessionKey] },
            archivePreviousTranscript: false,
            buildNextEntry: () => ({
              ...before,
              lifecycleRevision: "command-reset-generation",
              updatedAt: Date.now(),
            }),
          });
          expect(reset.nextEntry.lifecycleRevision).not.toBe(before.lifecycleRevision);
          activeSignal = undefined;
          expect(await invoke()).toEqual({
            shouldContinue: false,
            reply: { text: "old child refused" },
          });
        },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      releaseSwarmRun("command-capacity");
      failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
      const disposal = await disposePluginRegistryInstances(builder.registry);
      expect(disposal.failures).toEqual([]);
      source.closeRequest();
      source.revoke();
      options.throwBoundFailures(failures);
    }
  });
}
