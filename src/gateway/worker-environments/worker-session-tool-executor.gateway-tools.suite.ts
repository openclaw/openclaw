import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { finalizeAgentTools } from "../../agents/agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { healthSummary } from "../../commands/health.test-fixtures.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import {
  getInProcessGatewayRequestContext,
  withPluginRuntimePluginScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import {
  SOURCE,
  type installWorkerSessionToolTestFixture,
} from "./worker-session-tool-executor.test-support.js";

function gatewayProbeContext(): GatewayRequestContext {
  const context: Partial<GatewayRequestContext> = {
    getRuntimeConfig: () => ({}),
    trackExecution: async <T>(run: () => T | Promise<T>): Promise<T> => run(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => healthSummary(),
  };
  // SAFETY: This isolated probe invokes only these four methods, never other Gateway context members.
  return context as GatewayRequestContext;
}

export function registerWorkerGatewayToolExecutionTests(
  getFixture: ReturnType<typeof installWorkerSessionToolTestFixture>,
) {
  it.each(["rewrite", "invalid-rewrite", "deny", "revoke"] as const)(
    "runs generic Gateway tools under worker authority through shared hooks (%s)",
    async (decision) => {
      const { setEntry, placements, sourceClaim, identity } = getFixture();
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      await placements.authorizeWorkerTurnTools(sourceClaim, ["worker_probe", "worker_sibling"]);
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
        const caller = getGatewayToolCallerIdentity();
        expect(caller).toMatchObject(expectedCaller);
        expect(caller?.assertToolAllowed).toBeTypeOf("function");
        expect(() => caller?.assertToolAllowed?.("worker_sibling")).toThrow(
          "Worker tool authority changed",
        );
        if (decision === "revoke") {
          entered.resolve();
          await release.promise;
          expect(() => caller?.assertToolAllowed?.("worker_probe")).toThrow(
            "Worker tool authority changed",
          );
        } else {
          caller?.assertToolAllowed?.("worker_probe");
        }
        return decision === "deny"
          ? { block: true, blockReason: "generic tool disabled by policy" }
          : { params: { value: decision === "invalid-rewrite" ? 3 : "rewritten" } };
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
        const caller = getGatewayToolCallerIdentity();
        expect(caller).toMatchObject(expectedCaller);
        caller?.assertToolAllowed?.("worker_probe");
        return { content: [], details: { received: args } };
      });
      const runtime = getFixture().createToolRuntime({
        prepareTools: () =>
          finalizeAgentTools({
            tools: [
              {
                name: "worker_probe",
                label: "Worker check",
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
          decision === "deny"
            ? "generic tool disabled by policy"
            : decision === "invalid-rewrite"
              ? "Invalid worker_probe arguments"
              : "Worker tool authority changed",
        );
      }
    },
  );

  it("routes a generic plugin Gateway request through the worker's bound host instance", async () => {
    const { setEntry, placements, sourceClaim, identity } = getFixture();
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await placements.authorizeWorkerTurnTools(sourceClaim, ["worker_plugin_probe"]);
    const context = gatewayProbeContext();
    const runtime = getFixture().createToolRuntime({
      resolveGatewayContext: () => context,
      prepareTools: () => [
        {
          name: "worker_plugin_probe",
          label: "Worker plugin probe",
          description: "Exercise plugin Gateway request routing",
          parameters: Type.Object({ value: Type.String() }),
          execute: async () =>
            withPluginRuntimePluginScope(
              { pluginId: "worker-plugin-probe", pluginOrigin: "bundled" },
              async () => {
                expect(getInProcessGatewayRequestContext()).toBe(context);
                const health = await createPluginRuntime().gateway.request("health", {});
                return { content: [], details: { health } };
              },
            ),
        },
      ],
    });
    const surface = await runtime.getSurface(identity);
    const tool = surface.tools.find((entry) => entry.definition.name === "worker_plugin_probe");
    if (!tool) {
      throw new Error("Expected the admitted generic plugin tool");
    }
    const result = await runtime.invoke(
      identity,
      {
        generation: surface.generation,
        toolId: tool.id,
        toolCallId: "worker-plugin-request",
        arguments: { value: "original" },
      },
      { send: () => {} },
    );
    if (result.isError) {
      throw new Error(JSON.stringify(result.details));
    }
    expect(result.details).toHaveProperty("health");
  });

  it("refuses a generic plugin request after its host Gateway instance is replaced", async () => {
    const { setEntry, placements, sourceClaim, identity } = getFixture();
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await placements.authorizeWorkerTurnTools(sourceClaim, ["worker_plugin_probe"]);
    const original = gatewayProbeContext();
    const foreign = gatewayProbeContext();
    let current = original;
    const entered = createDeferred();
    const release = createDeferred();
    const runtime = getFixture().createToolRuntime({
      resolveGatewayContext: () => current,
      prepareTools: () => [
        {
          name: "worker_plugin_probe",
          label: "Worker plugin probe",
          description: "Exercise plugin Gateway request routing",
          parameters: Type.Object({ value: Type.String() }),
          execute: async () =>
            withPluginRuntimePluginScope(
              { pluginId: "worker-plugin-probe", pluginOrigin: "bundled" },
              async () => {
                entered.resolve();
                await release.promise;
                const health = await createPluginRuntime().gateway.request("health", {});
                return { content: [], details: { health } };
              },
            ),
        },
      ],
    });
    const surface = await runtime.getSurface(identity);
    const tool = surface.tools.find((entry) => entry.definition.name === "worker_plugin_probe");
    if (!tool) {
      throw new Error("Expected the admitted generic plugin tool");
    }
    const invocation = runtime.invoke(
      identity,
      {
        generation: surface.generation,
        toolId: tool.id,
        toolCallId: "worker-plugin-foreign-gateway",
        arguments: { value: "original" },
      },
      { send: () => {} },
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        invocation,
        "Generic plugin tool finished before its Gateway request",
      );
      current = foreign;
    } finally {
      release.resolve();
    }
    const result = await invocation;
    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringMatching(/Gateway|gateway/u),
    });
  });
}
