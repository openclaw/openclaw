import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { nativeSubagentRuntime } from "../../../plugins/runtime/native-subagent-context.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { resolveAgentWorkspaceDir } from "../../agent-scope.js";
import {
  gateAgentToolExecution,
  finalizeAgentToolAvailability,
} from "../../agent-tool-availability.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { holdQueuedSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { recordFinal } from "./subagent-spawn.boundary-run.test-support.js";
import { visibleResult } from "./subagent-spawn.fixtures.test-support.js";
import {
  holdNativeCapacity,
  nativeReplyFixture,
} from "./subagent-spawn.plugin-native-rewrite.test-support.js";
import {
  createSpawnTranscriptTarget,
  createSpawnOperatorSource,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

export function registerNativePluginPolicyCases(options: NativePluginSpawnTestOptions) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    throwBoundFailures,
    runEmbeddedAgent,
  } = options;
  registerNativePluginSandboxCases(options);
  it.each([
    { allowlist: ["read"], unavailable: "sessions_spawn", reader: "absent" },
    { allowlist: ["sessions_spawn"], unavailable: "agents_wait", reader: "absent" },
    { allowlist: ["sessions_spawn", "agents_wait"], unavailable: "agents_wait", reader: "gated" },
    {
      allowlist: ["sessions_spawn", "agents_wait"],
      unavailable: "agents_wait",
      reader: "shadowed",
    },
  ])(
    "native plugin facade refuses a denied $unavailable ($reader reader) before preparing or creating a child",
    async ({ allowlist, unavailable, reader }) => {
      const source = createSpawnOperatorSource();
      const bound = await createBoundParent(source.authority);
      const { parentSessionKey, parentRunId } = bound;
      const { context, runtime } = await createBoundGateway(bound);
      const failures: unknown[] = [];
      const agentTools = await import("../../agent-tools.js");
      const original = agentTools.createOpenClawCodingToolsInternalAsync;
      const preparation =
        reader === "absent"
          ? undefined
          : vi
              .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
              .mockImplementation(async (...args) => {
                const surface = await original(...args);
                const index = surface.findIndex((tool) => tool.name === "agents_wait");
                const wait = expectDefined(surface[index], "native agents_wait");
                // A same-named definition without the native reader binding shadows it.
                const replacement =
                  reader === "gated"
                    ? gateAgentToolExecution(wait, "denied requester")
                    : Object.assign({}, wait);
                return finalizeAgentToolAvailability(surface.with(index, replacement));
              });
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
                  runtimeToolAllowlist: allowlist,
                  inheritRuntimeToolAllowlist: true,
                },
                operatorAuthority: source.authority,
                assertCurrent: source.authority.assertCurrent,
                prepareSpawn,
              },
              { pluginId: "native-test", assertCurrent: source.authority.assertCurrent },
            );
            await expect(expectDefined(native.list, "denied native listing")()).rejects.toThrow(
              "agents_wait is not available",
            );
            await expect(
              native.collect({ ids: ["not-readable"], timeoutSeconds: 0 }),
            ).rejects.toThrow("agents_wait is not available");
            await expect(native.spawn({ requestId: "denied", task: "Do not run" })).rejects.toThrow(
              unavailable + " is not available",
            );
            expect(prepareSpawn).not.toHaveBeenCalled();
            expect(subagentRuns.size).toBe(0);
            expect(runEmbeddedAgent).not.toHaveBeenCalled();
          },
        );
      } catch (error) {
        failures.push(error);
      } finally {
        preparation?.mockRestore();
        source.closeRequest();
        failures.push(...(await closeBoundGateway(bound, runtime)));
        throwBoundFailures(failures);
      }
    },
  );
}

function registerNativePluginSandboxCases(options: NativePluginSpawnTestOptions) {
  it.each([
    { tool: "sessions_spawn", required: false, defaultAllowlist: false },
    { tool: "agents_wait", required: false, defaultAllowlist: false },
    { tool: "sessions_spawn", required: true, defaultAllowlist: false },
    { tool: "agents_wait", required: true, defaultAllowlist: false },
    { tool: "list", required: false, defaultAllowlist: false },
    { tool: "list", required: false, defaultAllowlist: true },
    { tool: "list", required: true, defaultAllowlist: false },
  ] as const)(
    "reply native facade enforces sandbox policy for $tool before effects (required=$required, default=$defaultAllowlist)",
    async ({ tool, required, defaultAllowlist }) => {
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
        target: createSpawnTranscriptTarget(bound, initialEntry),
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
            await recordFinal(bound, params, "private child result");
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
          if (tool === "list") {
            return expectDefined(nativeSubagentRuntime.list, "native list")();
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
            tools: {
              allow: ["sessions_spawn", "agents_wait"],
              deny: scenario.deny ? [tool === "list" ? "agents_wait" : tool] : [],
            },
          };
          if (defaultAllowlist && scenario.mode === "all" && scenario.deny) {
            delete bound.cfg.tools!.sandbox;
          }
          setRuntimeConfigSnapshot({ ...bound.cfg });
          const effects = async () => [
            [...subagentRuns.keys()],
            await transcript(),
            adopt.mock.calls.length,
            options.runEmbeddedAgent.mock.calls.length,
          ];
          const before = await effects();
          await inReply(async () => {
            const requestId = [scenario.mode, scenario.deny].join("-");
            if (scenario.blocked) {
              await expect(invoke(requestId)).rejects.toThrow(
                (tool === "list" ? "agents_wait" : tool) + " is not available",
              );
            } else {
              const result = await invoke(requestId);
              if (tool === "sessions_spawn") {
                expect(result).toMatchObject({ completionMode: "collect" });
              } else if (tool === "list") {
                expect(result).toEqual([
                  expect.objectContaining({
                    runId: childRunId,
                    requestId: "initial",
                    status: "done",
                  }),
                ]);
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
            expect(await effects()).toEqual(before);
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
