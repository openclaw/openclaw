import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import { nativeSubagentRuntime } from "../../../plugins/runtime/native-subagent-context.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { holdQueuedSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { visibleResult } from "./subagent-spawn.fixtures.test-support.js";
import {
  holdNativeCapacity,
  nativeReplyFixture,
} from "./subagent-spawn.plugin-native-rewrite.test-support.js";
import {
  createSpawnOperatorSource,
  recordSpawnBoundaryFinal,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerNativePluginSandboxCases(options: NativePluginSpawnTestOptions) {
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
