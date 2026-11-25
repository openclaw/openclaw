import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { waitForReplyRunSuccessorAdmission } from "../../sessions/session-controller.wait.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { createExecTool } from "../bash-tools.exec-run.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { jsonResult, type AnyAgentTool } from "./common.js";

export function runningOperation(sessionKey: string, sessionId: string, storeScope: string) {
  const operation = createTestReplyOperation({
    sessionKey,
    sessionId,
    target: captureSessionTarget({ storeScope, sessionKey, incarnation: sessionId }),
  });
  operation.setPhase("running");
  return operation;
}

export function reloadOrder(physicalCleanup: boolean) {
  return ["yield", ...(physicalCleanup ? ["physical-cleanup"] : []), "cleanup", "reload", "resume"];
}

export function queueReloadSuccessor(
  sessionKey: string,
  sessionId: string,
  storeScope: string,
  admitted: () => void,
) {
  return waitForReplyRunSuccessorAdmission(sessionKey, null, {
    target: captureSessionTarget({
      storeScope,
      sessionKey,
      agentId: "main",
      incarnation: sessionId,
    }),
  }).then((result) => {
    if (result.settled) {
      admitted();
    }
    return result;
  });
}

export async function runAdversarialReloadHandoff(params: {
  tool: AnyAgentTool;
  runAbort: AbortController;
  outcome: "code mode" | "adversarial native";
  order: string[];
  request: Record<string, unknown>;
  effectPath: string;
}) {
  const { tool, runAbort, outcome, order, request, effectPath } = params;

  const { createCatalogCodeModeHarness, jsonTool, resetCodeModeTestState } =
    await import("../code-mode.test-support.js");
  const { LegacyPluginSdkResourceHost, bindLegacyPluginSdkResourceHost } =
    await import("../../plugins/legacy-sdk-resource-host.js");
  const { createTestGatewayScheduler } =
    await import("../../test-utils/gateway-scheduler-clock.js");
  const { getPluginRuntimeGatewayRequestScope } =
    await import("../../plugins/runtime/gateway-request-scope.js");
  const { Agent } = await import("../runtime/index.js");
  const { makeAssistantMessage, reply, model } =
    await import("../../../packages/agent-core/src/agent-loop.test-support.js");
  const { readToolResultDetails } = await import("../tool-result-error.js");
  const host = new LegacyPluginSdkResourceHost();
  const scheduler = createTestGatewayScheduler();
  host.bindScheduler(scheduler);
  bindLegacyPluginSdkResourceHost(
    expectDefined(
      getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
      "Gateway test resolver",
    ),
    host,
  );
  try {
    const ready = createDeferred();
    const exited = createDeferred();
    let child: ReturnType<typeof spawn> | undefined;
    let pendingCanceled = false;
    const startPhysicalWork = () => {
      if (!child) {
        child = spawn(
          process.execPath,
          ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'],
          {
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        child.stdout?.once("data", () => ready.resolve());
        child.once("error", (error) => ready.reject(error));
        child.once("close", () => {
          pendingCanceled = true;
          order.push("physical-cleanup");
          exited.resolve();
        });
        runAbort.signal.addEventListener("abort", () => child?.kill(), { once: true });
      }
      return ready.promise;
    };
    const physicalExec = createExecTool({
      host: "gateway",
      mode: "full",
      ask: "off",
      allowBackground: false,
      notifyOnExit: false,
      scopeKey: "agent:main:reload",
    });
    let appendFailure: Error | undefined;
    let physicalResult: unknown;
    const beforeHandoff = jsonTool("append_once", { appended: true });
    beforeHandoff.execute = vi.fn(async (_id, _args, signal) => {
      try {
        await startPhysicalWork();
        const script =
          'require("node:fs").appendFileSync(' + JSON.stringify(effectPath) + ', "once\\n")';
        const result = await physicalExec.execute(
          "physical-append",
          {
            command: JSON.stringify(process.execPath) + " -e " + JSON.stringify(script),
            awaitResults: true,
          },
          signal,
        );
        physicalResult = result;
        expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
        return jsonResult({ appended: true });
      } catch (error) {
        appendFailure = error instanceof Error ? error : new Error(String(error));
        throw appendFailure;
      }
    });
    const pendingWork = jsonTool("pending_work", { canceled: true });
    pendingWork.execute = vi.fn(async () => {
      await startPhysicalWork();
      await exited.promise;
      return jsonResult({ canceled: true });
    });
    const afterHandoff = jsonTool("after_handoff", { continued: true });
    const after = vi.spyOn(afterHandoff, "execute").mockImplementation(async () => {
      // Terminate an observed stale continuation so the regression fails on the
      // forbidden invocation itself, never on a pending-work timeout.
      runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
      return jsonResult({ continued: true });
    });
    const harness = createCatalogCodeModeHarness([tool, beforeHandoff, pendingWork, afterHandoff], {
      abortSignal: runAbort.signal,
    });
    const code =
      'const pending = pending_work({}); json(await append_once({})); try { await plugins({ action: "reloadAndResume", pluginId: "reload-fixture" }); } catch {} return await after_handoff({});';
    let modelRequests = 0;
    const agent = new Agent({
      initialState: {
        model,
        tools:
          outcome === "code mode"
            ? harness.tools.map((candidate) => wrapToolWithAbortSignal(candidate, runAbort.signal))
            : [tool, beforeHandoff, afterHandoff].map((candidate) =>
                wrapToolWithAbortSignal(candidate, runAbort.signal),
              ),
      },
      streamFn: async () => {
        if (++modelRequests > 3) {
          throw new Error("old run kept requesting tools");
        }
        // This provider never returns a final answer, including after tool errors.
        return reply(
          makeAssistantMessage(
            modelRequests > (outcome === "code mode" ? 1 : 2)
              ? [{ type: "toolCall", id: "after", name: "after_handoff", arguments: {} }]
              : outcome === "code mode"
                ? [
                    {
                      type: "toolCall",
                      id: "code-call-1",
                      name: "exec",
                      arguments: { code, awaitResults: true },
                    },
                  ]
                : modelRequests === 1
                  ? [{ type: "toolCall", id: "append", name: "append_once", arguments: {} }]
                  : [{ type: "toolCall", id: "handoff", name: "plugins", arguments: request }],
          ),
        );
      },
    });
    const onAbort = () => agent.abort(runAbort.signal.reason);
    runAbort.signal.addEventListener("abort", onAbort, { once: true });
    // The pre-fix runner only interrupts at this checkpoint, after guest execution.
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "turn_end" && order.includes("yield") && !runAbort.signal.aborted) {
        runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
        agent.abort(SESSIONS_YIELD_ABORT_REASON);
      }
    });
    try {
      await agent.prompt("Reload the plugin, and keep requesting tools forever.");
    } finally {
      unsubscribe();
      runAbort.signal.removeEventListener("abort", onAbort);
    }
    await exited.promise;
    if (appendFailure) {
      throw appendFailure;
    }
    expect(order).toEqual(["yield", "physical-cleanup"]);
    expect(after).not.toHaveBeenCalled();
    expect(physicalResult).toMatchObject({ details: { status: "completed", exitCode: 0 } });
    expect(pendingCanceled).toBe(true);
    expect(modelRequests).toBe(outcome === "code mode" ? 1 : 2);
    expect(await fs.readFile(effectPath, "utf8")).toBe("once\n");
    const message = agent.state.messages.findLast(
      (toolMessage) =>
        toolMessage.role === "toolResult" &&
        toolMessage.toolName === (outcome === "code mode" ? "exec" : "plugins"),
    );
    const details = readToolResultDetails(message);
    const receipt = outcome === "code mode" ? details?.value : details;
    expect(receipt).toMatchObject({ status: "started", async: true, yielded: true });
    if (outcome === "code mode") {
      expect(pendingWork.execute).toHaveBeenCalledTimes(1);
      expect(pendingCanceled).toBe(true);
      expect(details).toMatchObject({
        status: "completed",
        output: [{ type: "json", value: { appended: true } }],
      });
    }
    return { details: receipt };
  } finally {
    runAbort.abort();
    await resetCodeModeTestState();
    await host.close();
    await scheduler.stop();
  }
}
