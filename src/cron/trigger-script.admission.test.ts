import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import { resolveToolSearchConfig, type ToolSearchToolContext } from "../agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

function completed(value: unknown): CodeModeHeadlessResult {
  return { status: "completed", value, output: [], toolCallCount: 1 };
}

function toolRuntime(ctx: ToolSearchToolContext) {
  return new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.runtimeConfig), {
    prepareInput: true,
    validateInput: true,
  });
}

function fixture(
  execute: AnyAgentTool["execute"],
  deps: Partial<Parameters<typeof createCronScriptRuntime>[0]> = {},
  prepareBeforeToolCallParams?: AnyAgentTool["prepareBeforeToolCallParams"],
) {
  const config = {};
  const admitted: AdmittedRunContext[] = [];
  const retained: ToolSearchToolContext[] = [];
  const prepare = vi.fn(async () => ({
    createTools: async (): Promise<AnyAgentTool[]> => [
      {
        name: "probe",
        label: "Probe",
        description: "Observe the invocation owner",
        parameters: { type: "object", properties: {} },
        execute,
        prepareBeforeToolCallParams,
      },
    ],
    context: { config, agentId: "main", sessionKey: "agent:main:cron:probe" },
  }));
  const runtime = createCronScriptRuntime({
    config,
    prepareRuntime: prepare,
    runHeadless: async ({ ctx }) => {
      retained.push(ctx);
      return completed({ fire: false, state: await toolRuntime(ctx).callValue("probe", {}) });
    },
    ...deps,
  });
  const input = {
    jobId: "probe",
    script: "return result",
    state: null,
    executionIdentity: {
      ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" } as const,
      onPostAdmission: (context: AdmittedRunContext) => {
        admitted.push(context);
      },
    },
  };
  return { runtime, prepare, admitted, retained, input };
}

it("gives each warm payload invocation fresh authority and releases it after completion", async () => {
  const { runtime, prepare, admitted, retained, input } = fixture(async () => {
    const caller = getGatewayToolCallerIdentity();
    return jsonResult({
      owned: Boolean(caller?.operationalRunInstance && caller.approvalAuthority),
    });
  });
  for (let index = 0; index < 2; index += 1) {
    await expect(runtime.executePayload(input)).resolves.toMatchObject({
      kind: "completed",
      state: { owned: true },
    });
    expect(getAdmittedRunDelegatedAuthority(admitted[index]!)).toBeUndefined();
    await expect(toolRuntime(retained[index]!).callValue("probe", {})).rejects.toThrow();
  }
  expect(prepare).toHaveBeenCalledOnce();
  expect(admitted).toHaveLength(2);
  expect(admitted[1]?.operationalRunInstance).not.toBe(admitted[0]?.operationalRunInstance);
  expect(retained.map((ctx) => ctx.runId)).toEqual(
    admitted.map((context) => context.operationalRunInstance.runId),
  );
});

it.each(["admission", "gateway", "abort"] as const)(
  "fences %s revocation during preparation before any source effect",
  async (revocation) => {
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    let gateway = {} as GatewayRequestContext;
    const execute = vi.fn(async () => jsonResult({ changed: true }));
    const { runtime, admitted, input } = fixture(
      execute,
      { resolveGatewayContext: () => gateway },
      async (args: unknown) => {
        entered.resolve();
        await release.promise;
        return args;
      },
    );
    const result = runtime.executePayload({ ...input, abortSignal: controller.signal });
    try {
      await entered.promise;
      expect(admitted[0]).toBeDefined();
      if (revocation === "admission") {
        closeAdmittedRunDelegatedAuthority(admitted[0]!);
      } else if (revocation === "gateway") {
        gateway = {} as GatewayRequestContext;
      } else {
        controller.abort();
      }
      release.resolve();
      await expect(result).resolves.toMatchObject({ kind: "error" });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await result;
    }
  },
);

it("keeps concurrent invocations independent while sharing prepared tools", async () => {
  const entered = [createDeferred(), createDeferred()];
  const release = [createDeferred(), createDeferred()];
  let calls = 0;
  const { runtime, prepare, admitted, input } = fixture(async () => {
    const index = calls++;
    const before = getGatewayToolCallerIdentity()?.operationalRunInstance;
    entered[index]!.resolve();
    await release[index]!.promise;
    return jsonResult({
      owned:
        before !== undefined && before === getGatewayToolCallerIdentity()?.operationalRunInstance,
    });
  });
  const first = runtime.evaluateTrigger(input);
  const second = runtime.evaluateTrigger(input);
  try {
    await Promise.all(entered.map((entry) => entry.promise));
    release[0]!.resolve();
    await expect(first).resolves.toMatchObject({ kind: "evaluated", state: { owned: true } });
    expect(getAdmittedRunDelegatedAuthority(admitted[1]!)).toBeDefined();
    release[1]!.resolve();
    await expect(second).resolves.toMatchObject({ kind: "evaluated", state: { owned: true } });
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    release.forEach((entry) => entry.resolve());
    await Promise.all([first, second]);
  }
});
