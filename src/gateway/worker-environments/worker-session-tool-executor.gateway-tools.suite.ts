import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { finalizeAgentTools } from "../../agents/agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import {
  SOURCE,
  type installWorkerSessionToolTestFixture,
} from "./worker-session-tool-executor.test-support.js";

export function registerWorkerGatewayToolExecutionTests(
  getFixture: ReturnType<typeof installWorkerSessionToolTestFixture>,
) {
  it.each(["rewrite", "deny", "revoke"] as const)(
    "runs generic Gateway tools under worker authority through shared hooks (%s)",
    async (decision) => {
      const { setEntry, placements, sourceClaim, identity } = getFixture();
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      await placements.authorizeWorkerTurnTools(sourceClaim, ["worker_probe"]);
      const entered = createDeferred();
      const release = createDeferred();
      const afterObserved = createDeferred();
      const expectedCaller = {
        agentId: SOURCE.agentId,
        sessionKey: SOURCE.sessionKey,
        workerTurnClaim: sourceClaim,
        operatorAuthority: { profileId: "profile-worker-requester" },
      };
      const beforeToolCall = vi.fn(async () => {
        expect(getGatewayToolCallerIdentity()).toMatchObject(expectedCaller);
        if (decision === "revoke") {
          entered.resolve();
          await release.promise;
        }
        return decision === "deny"
          ? { block: true, blockReason: "generic tool disabled by policy" }
          : { params: { value: "rewritten" } };
      });
      const afterToolCall = vi.fn(() => {
        expect(getGatewayToolCallerIdentity()).toMatchObject(expectedCaller);
        afterObserved.resolve();
      });
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_tool_call", matcher: ["worker_probe"], handler: beforeToolCall },
          { hookName: "after_tool_call", matcher: ["worker_probe"], handler: afterToolCall },
        ]),
      );
      const effect = vi.fn<AnyAgentTool["execute"]>(async (_id, args) => {
        expect(getGatewayToolCallerIdentity()).toMatchObject(expectedCaller);
        return { content: [], details: { received: args } };
      });
      const runtime = getFixture().createToolRuntime({
        prepareTools: () =>
          finalizeAgentTools({
            tools: [
              {
                name: "worker_probe",
                label: "Worker probe",
                description: "Synthetic Gateway-owned effect",
                parameters: Type.Object({ value: Type.String() }),
                execute: effect,
              },
            ],
            hookContext: {
              agentId: SOURCE.agentId,
              sessionId: SOURCE.sessionId,
              sessionKey: SOURCE.sessionKey,
              runId: sourceClaim.runId,
            },
          }),
      });
      const surface = await runtime.getSurface(identity);
      const tool = surface.tools.find((entry) => entry.definition.name === "worker_probe");
      if (!tool) {
        throw new Error("Expected the admitted generic Gateway tool");
      }
      const invocation = runtime.invoke(
        identity,
        {
          generation: surface.generation,
          toolId: tool.id,
          toolCallId: `generic-${decision}`,
          arguments: { value: "original" },
        },
        { send: () => {} },
      );
      try {
        if (decision === "revoke") {
          await awaitGateBeforeSettlement(
            entered.promise,
            invocation,
            "Generic tool finished before its policy hook",
          );
          await placements.authorizeWorkerTurnTools(sourceClaim, []);
        }
      } finally {
        release.resolve();
      }
      const result = await invocation;
      await afterObserved.promise;
      expect(beforeToolCall).toHaveBeenCalledOnce();
      expect(afterToolCall).toHaveBeenCalledOnce();
      expect(effect).toHaveBeenCalledTimes(decision === "rewrite" ? 1 : 0);
      if (decision === "rewrite") {
        expect(result.details).toEqual({ received: { value: "rewritten" } });
        expect(afterToolCall).toHaveBeenCalledWith(
          expect.objectContaining({
            params: { value: "rewritten" },
            result: expect.objectContaining({ details: result.details }),
          }),
          expect.objectContaining({
            agentId: SOURCE.agentId,
            sessionKey: SOURCE.sessionKey,
            runId: sourceClaim.runId,
          }),
        );
      } else {
        expect(JSON.stringify(result)).toContain(
          decision === "deny" ? "generic tool disabled by policy" : "Worker tool authority changed",
        );
      }
    },
  );
}
