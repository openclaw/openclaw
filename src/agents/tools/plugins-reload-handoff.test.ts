import { afterEach, expect, it, vi } from "vitest";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as exec from "../../infra/exec-request-context.js";
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

const request = { action: "reloadAndResume", pluginId: "reload-fixture" };
const callerRequired = "active Gateway conversation";
afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});
it.each([
  ["success", '"generation":2'],
  ["reload failure", "fixture reload failed"],
  ["permission denied", "operator.admin"],
  ["stop", ""],
])("ends the turn before reload and resumes once: %s", async (outcome, expectedText) => {
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
    const context = createContext([["plugins.reload", "operator.admin", "plugins", endpoint]]);
    context.getRuntimeConfig = () => config;
    context.resolveGatewayContext = () => context;
    const enqueue = vi
      .spyOn(events, "enqueueSessionEventForHost")
      .mockImplementation((text, opts) => {
        expect(opts).toMatchObject({ sessionKey, expectedTarget: { sessionId } });
        order.push("resume");
        resumed.resolve(text);
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
    const run = async () => {
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
      const result = await tool.execute("handoff", request);
      expect(result.details).toMatchObject({ status: "started", async: true, yielded: true });
      const asyncStarted = isAsyncStartedToolResult(result);
      expect(asyncStarted).toBe(true);
      expect(hasYieldContinuationEvidence({ toolMetas: [{ asyncStarted }] })).toBe(true);
      expect(order).toEqual(["yield"]);
      expect(endpoint).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      await expect(sourceTool.execute("duplicate", request)).rejects.toThrow(callerRequired);
      if (outcome === "stop") {
        exec.cancelExecRequestOwners(exec.activeExecRequestOwners({ sessionKey }, () => true));
        cleanup.resolve();
        await operation.ownerSettlement;
        return;
      }
      cleanup.resolve();
      const text = await resumed.promise;
      expect(order).toEqual([
        "yield",
        "cleanup",
        ...(outcome === "permission denied" ? [] : ["reload"]),
        "resume",
      ]);
      expect(text).toContain(expectedText);
      expect(enqueue).toHaveBeenCalledOnce();
    };
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
              exec.withExecRequestTurn(
                { identity: { agentId: "main", sessionKey, sessionId, runId } },
                () => withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, run),
              ),
          ),
      );
      if (outcome === "stop") {
        expect(endpoint).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
      }
    } finally {
      cleanup.resolve();
      operation.complete();
      await consumer.close(() => undefined);
      await plugin.dispose();
    }
  });
});
it("refuses an unsupported caller without pretending to schedule a reload", async () => {
  await expect(createPluginsTool().execute("unsupported", request)).rejects.toThrow(callerRequired);
});
