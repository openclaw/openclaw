import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  activeExecRequestOwners,
  cancelExecRequestOwners,
  withExecRequestTurn,
} from "../../infra/exec-request-context.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { hasYieldContinuationEvidence } from "../embedded-agent-runner/run/incomplete-turn-resolution.js";
import { isAsyncStartedToolResult } from "../embedded-agent-tool-results.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createPluginsTool } from "./plugins-tool.js";

// Real tool, reply settlement, plugin consumer cleanup and RPC authorization. Only the
// reload endpoint's implementation and the next inference turn are controlled I/O.
describe("plugin reload turn handoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
  });

  it.each(["success", "reload failure", "permission denied", "stop"] as const)(
    "ends the turn before reload and resumes once: %s",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sessionKey = "agent:main:reload";
        const sessionId = "reload-session";
        const runId = "reload-run";
        const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
        setRuntimeConfigSnapshot(config);
        await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
        const runAbort = new AbortController();
        const operation = createTestReplyOperation({ sessionKey, sessionId });
        operation.setPhase("running");
        const cleanup = createDeferredCore();
        const finished = createDeferredCore();
        const resumed = createDeferredCore<string>();
        const plugin = new PluginInstance("reload-fixture");
        const consumer = plugin.retainConsumer();
        const order: string[] = [];
        const endpoint = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
          expect(plugin.hasRetainedConsumers).toBe(false);
          order.push("reload");
          if (outcome === "reload failure") {
            respond(false, undefined, { code: "UNAVAILABLE", message: "fixture reload failed" });
          } else {
            respond(true, { ok: true, runtime: { generation: 2, pluginIds: ["reload-fixture"] } });
          }
        });
        const context = createContext();
        context.getRuntimeConfig = () => config;
        context.resolveGatewayContext = () => context;
        const methods = createGatewayMethodRegistry([
          {
            name: "plugins.reload",
            scope: "operator.admin",
            owner: { kind: "core", area: "plugins" },
            handler: endpoint,
          },
        ]);
        context.getGatewayMethodRegistry = () => methods;
        const enqueue = vi
          .spyOn(events, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            expect(options.sessionKey).toBe(sessionKey);
            expect(options.expectedTarget?.sessionId).toBe(sessionId);
            order.push("resume");
            resumed.resolve(text);
            finished.resolve();
            return {
              id: "resume",
              cancel: () => false,
              accepted: Promise.resolve({ ok: true }),
              settled: Promise.resolve({
                status: "completed",
                executionStarted: true,
                delivered: false,
              }),
            };
          });
        try {
          await withPluginRuntimeGatewayRequestScope(
            { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
            () =>
              withOperatorToolGatewayAuthority(
                {
                  scopes: outcome === "permission denied" ? ["operator.write"] : ["operator.admin"],
                  operatorRoleActor: { kind: "system" },
                },
                () =>
                  withExecRequestTurn(
                    { identity: { agentId: "main", sessionKey, sessionId, runId } },
                    () =>
                      withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, async () => {
                        const sourceTool = createPluginsTool({
                          sessionId,
                          runId,
                          onYield: () => {
                            order.push("yield");
                            runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
                            // Mirror the runtime: cleanup owns its asynchronous consumer close.
                            const closing = consumer.close(async () => {
                              await cleanup.promise;
                              order.push("cleanup");
                            });
                            operation.completeWithAfterClearBarrier(closing);
                          },
                        });
                        const tool = wrapToolWithAbortSignal(sourceTool, runAbort.signal);
                        const result = await tool.execute("handoff", {
                          action: "reloadAndResume",
                          pluginId: "reload-fixture",
                        });
                        expect(result.details).toMatchObject({
                          status: "started",
                          async: true,
                          yielded: true,
                        });
                        // Use the normal result observer contract: this yield has a continuation,
                        // not the otherwise-correct warning to send a message to resume.
                        expect(isAsyncStartedToolResult(result)).toBe(true);
                        expect(
                          hasYieldContinuationEvidence({
                            toolMetas: [{ asyncStarted: isAsyncStartedToolResult(result) }],
                          }),
                        ).toBe(true);
                        expect(order).toEqual(["yield"]);
                        expect(endpoint).not.toHaveBeenCalled();
                        expect(enqueue).not.toHaveBeenCalled();
                        await expect(
                          sourceTool.execute("duplicate", {
                            action: "reloadAndResume",
                            pluginId: "reload-fixture",
                          }),
                        ).rejects.toThrow("active Gateway conversation");
                        if (outcome === "stop") {
                          cancelExecRequestOwners(
                            activeExecRequestOwners({ sessionKey }, () => true),
                          );
                          cleanup.resolve();
                          await operation.ownerSettlement;
                          return;
                        }
                        cleanup.resolve();
                        const text = await resumed.promise;
                        expect(order).toEqual(
                          outcome === "permission denied"
                            ? ["yield", "cleanup", "resume"]
                            : ["yield", "cleanup", "reload", "resume"],
                        );
                        expect(text).toContain(
                          outcome === "success"
                            ? '"generation":2'
                            : outcome === "reload failure"
                              ? "fixture reload failed"
                              : "operator.admin",
                        );
                        expect(enqueue).toHaveBeenCalledOnce();
                      }),
                  ),
              ),
          );
          if (outcome === "stop") {
            expect(endpoint).not.toHaveBeenCalled();
            expect(enqueue).not.toHaveBeenCalled();
          } else {
            await finished.promise;
          }
        } finally {
          cleanup.resolve();
          operation.complete();
          await consumer.close(() => undefined);
          await plugin.dispose();
        }
      });
    },
  );

  it("refuses an unsupported caller without pretending to schedule a reload", async () => {
    await expect(
      createPluginsTool().execute("unsupported", {
        action: "reloadAndResume",
        pluginId: "fixture",
      }),
    ).rejects.toThrow("active Gateway conversation");
  });
});
