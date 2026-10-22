import { afterEach, expect, it, vi } from "vitest";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as exec from "../../infra/exec-request-context.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { hasYieldContinuationEvidence } from "../embedded-agent-runner/run/incomplete-turn-resolution.js";
import { isAsyncStartedToolResult } from "../embedded-agent-tool-results.js";
import { withPreparedEmbeddedRunToolAuthority } from "../harness/tool-authority.runtime.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createPluginsTool } from "./plugins-tool.js";

const request = { action: "reloadAndResume", pluginId: "reload-fixture" };
const callerRequired = "active Gateway conversation";
afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});
it.each([
  ["success", '"generation":2'],
  ["without run ID", '"generation":2'],
  ["same-ID without run ID", ""],
  ["same-ID callback", '"generation":2'],
  ["same-ID late construction", '"generation":2'],
  ["same-ID prepublication", '"generation":2'],
  ["same-ID unmatched run", ""],
  ["reload failure", "fixture reload failed"],
  ["permission denied", "operator.admin"],
  ["stop", ""],
])("ends the turn before reload and resumes once: %s", async (outcome, expectedText) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:reload";
    const sessionId = "reload-session";
    const runId = "reload-run";
    const withoutRunId = outcome === "without run ID" || outcome === "same-ID without run ID";
    const refusesHandoff =
      outcome === "same-ID unmatched run" || outcome === "same-ID without run ID";
    const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    setRuntimeConfigSnapshot(config);
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
    const runAbort = new AbortController();
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const runningOperation = (storeScope: string) => {
      const operation = createTestReplyOperation({
        sessionKey,
        sessionId,
        target: captureSessionTarget({ storeScope, sessionKey, incarnation: sessionId }),
      });
      operation.setPhase("running");
      return operation;
    };
    const operation = runningOperation(storePath);
    const other = outcome.startsWith("same-ID")
      ? runningOperation(state.path("other", "sessions.json"))
      : undefined;
    if (outcome !== "same-ID prepublication" && outcome !== "same-ID unmatched run") {
      operation.attachBackend({ kind: "embedded", runId, cancel: () => {} });
    }
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
    const expectNoHandoff = () => {
      expect(endpoint).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    };
    const run = async () => {
      const createTool = () =>
        createPluginsTool({
          sessionId,
          ...(withoutRunId ? {} : { runId }),
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
      const start = async () => {
        const sourceTool =
          outcome !== "same-ID callback" && other
            ? withSessionControllerOwner(other, createTool)
            : withSessionControllerOwner(operation, createTool);
        const tool = wrapToolWithAbortSignal(sourceTool, runAbort.signal);
        const execute = () =>
          other
            ? withSessionControllerOwner(other, () => tool.execute("handoff", request))
            : tool.execute("handoff", request);
        if (refusesHandoff) {
          await expect(execute()).rejects.toThrow(callerRequired);
          expect(order).toEqual([]);
          expectNoHandoff();
          expect(operation.result).toBeNull();
          expect(other).toMatchObject({ result: null, abortSignal: { aborted: false } });
          return;
        }
        const result = await execute();
        expect(result.details).toMatchObject({ status: "started", async: true, yielded: true });
        const asyncStarted = isAsyncStartedToolResult(result);
        expect(asyncStarted).toBe(true);
        expect(hasYieldContinuationEvidence({ toolMetas: [{ asyncStarted }] })).toBe(true);
        expect(order).toEqual(["yield"]);
        expectNoHandoff();
        await expect(sourceTool.execute("duplicate", request)).rejects.toThrow(
          outcome === "same-ID prepublication"
            ? "This turn already handed off a plugin reload."
            : callerRequired,
        );
      };
      if (outcome === "same-ID prepublication") {
        const admission = prepareSystemAgentRunAdmission(config, runId, "main", "reload-test");
        try {
          const admittedRunContext = await admission.admit("embedded", "reload-test");
          await withPreparedEmbeddedRunToolAuthority(
            {
              admittedRunContext,
              replyOperation: operation,
            },
            {
              config,
              runId,
              sessionId,
              sessionKey,
              agentId: "main",
              sessionFile: state.path("reload-session.jsonl"),
              workspaceDir: state.workspaceDir,
              provider: "openai",
              modelId: "gpt-test",
              sandboxSessionKey: sessionKey,
              senderIsOwner: true,
              abortSignal: runAbort.signal,
            },
            undefined,
            () =>
              withGatewayToolCallerIdentity(
                createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext,
                  agentId: "main",
                  sessionKey,
                  approvalSignals: [runAbort.signal],
                }),
                start,
              ),
          );
        } finally {
          admission.close();
        }
      } else {
        await start();
      }
      if (refusesHandoff) {
        return;
      }
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
      if (other) {
        expect(other).toMatchObject({
          phase: "running",
          result: null,
          abortSignal: { aborted: false },
        });
      }
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
        expectNoHandoff();
      }
    } finally {
      cleanup.resolve();
      operation.complete();
      other?.complete();
      await consumer.close(() => undefined);
      await plugin.dispose();
    }
  });
});
it("refuses an unsupported caller without pretending to schedule a reload", async () => {
  await expect(createPluginsTool().execute("unsupported", request)).rejects.toThrow(callerRequired);
});
