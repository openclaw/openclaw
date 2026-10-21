import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { runCodeModeScriptHeadless, type CodeModeHeadlessResult } from "../agents/code-mode.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import { resolveToolSearchConfig, type ToolSearchToolContext } from "../agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

type EvaluatorDeps = Parameters<typeof createCronScriptRuntime>[0];
type HeadlessParams = Parameters<NonNullable<EvaluatorDeps["runHeadless"]>>[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function completed(
  value: unknown,
  output: unknown[] = [],
  toolCallCount = 0,
): CodeModeHeadlessResult {
  return { status: "completed", value, output, toolCallCount };
}

function createPreparedRuntime(config: OpenClawConfig, tools?: AnyAgentTool[]) {
  const context = { config, agentId: "main", sessionKey: "cron:test:trigger" };
  const tool = wrapToolWithBeforeToolCallHook(makeTool("probe", vi.fn()), context);
  return { createTools: async () => tools ?? [tool], context };
}

function makeTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute,
  };
}

function createEvaluator(
  result: CodeModeHeadlessResult | NonNullable<EvaluatorDeps["runHeadless"]> = completed({
    fire: false,
  }),
  deps: Partial<Omit<EvaluatorDeps, "runHeadless">> = {},
) {
  const config = deps.config ?? {};
  const runHeadless = vi.fn(async (params: HeadlessParams) =>
    typeof result === "function" ? result(params) : result,
  );
  const prepareRuntime = vi.fn<NonNullable<EvaluatorDeps["prepareRuntime"]>>(
    deps.prepareRuntime ?? (async () => createPreparedRuntime(config)),
  );
  const runtime = createCronScriptRuntime({ ...deps, config, runHeadless, prepareRuntime });
  type Input = Partial<Parameters<typeof runtime.evaluateTrigger>[0]>;
  return {
    evaluate: (input: Input = {}) => runtime.evaluateTrigger({ ...INPUT, ...input }),
    executePayload: (input: Input = {}) => runtime.executePayload({ ...INPUT, ...input }),
    prepareRuntime,
    runHeadless,
  };
}

const INPUT = { jobId: "probe", script: "return result", state: null };
const INTERNAL_ERROR = expect.objectContaining({ kind: "error", code: "internal_error" });

function execEvaluator(host: "auto" | "node" | "gateway", node?: string) {
  return createCronScriptRuntime({
    config: {
      agents: { defaults: { workspace: tempDirs.make("openclaw-cron-exec-") } },
      tools: { exec: { host, node, security: "full", ask: "off" } },
    },
  }).evaluateTrigger;
}

function triggerNamespace(entries: Array<[string, unknown]>) {
  return [
    {
      id: "cron:trigger",
      globalName: "trigger",
      scope: {
        kind: "object",
        entries: entries.map(([name, value]) => [name, { kind: "value", value }]),
      },
    },
  ];
}

it("does not scaffold an implicit ACP workspace during trigger execution (#92015)", async () => {
  const parentRepo = tempDirs.make("openclaw-cron-acp-workspace-");
  expect(spawnSync("git", ["init", "-q"], { cwd: parentRepo }).status).toBe(0);
  const workspaceDir = path.join(parentRepo, ".openclaw", "workspace");
  const config: OpenClawConfig = {
    agents: {
      defaults: { workspace: workspaceDir },
      entries: { codex: { runtime: { type: "acp", acp: { agent: "codex", cwd: parentRepo } } } },
    },
    plugins: { enabled: false },
  };
  const runtime = createCronScriptRuntime({
    config,
    runHeadless: async () => completed({ fire: false }),
  });
  await runtime.evaluateTrigger({
    ...INPUT,
    agentId: "codex",
    script: "return { fire: false }",
    toolsAllow: [],
  });
  expect(fs.existsSync(path.join(workspaceDir, "AGENTS.md"))).toBe(false);
  expect(fs.existsSync(path.join(workspaceDir, ".git"))).toBe(false);
  expect(spawnSync("git", ["add", "-A"], { cwd: parentRepo }).status).toBe(0);
});

it.each([
  { host: "auto", expected: { kind: "evaluated", fire: false } },
  {
    host: "node",
    expected: {
      kind: "error",
      code: "internal_error",
      error: expect.stringContaining(
        "exec host not allowed (requested gateway; configured host is node",
      ),
    },
  },
] as const)(
  "honors current host $host for a canonically captured pinned exec cap",
  async ({ host, expected }) => {
    const evaluate = execEvaluator(host, "configured-node-must-not-run");
    const input = {
      ...INPUT,
      toolsAllow: ["exec", "process"],
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      execTarget: { version: 1, host: "gateway" },
    } satisfies Parameters<typeof evaluate>[0];

    await expect(
      evaluate({
        ...input,
        script: 'await exec({ command: "printf openclaw-canonical-ok" }); return { fire: false };',
      }),
    ).resolves.toEqual(expected);
  },
);

it("keeps an uncanonicalized alias-name cap fail-closed for exec", async () => {
  const evaluate = execEvaluator("gateway");

  const result = await evaluate({
    ...INPUT,
    script: 'await exec({ command: "printf must-not-run" }); return { fire: false };',
    toolsAllow: ["gateway_exec"],
    scheduledToolPolicy: { version: 1, mode: "trusted" },
  });

  expect(result).toMatchObject({ kind: "error", code: "internal_error" });
  expect(result.kind === "error" ? result.error : "").toContain("exec is not defined");
});

it.each([
  [
    "prefers the return value",
    completed({ fire: true, message: "changed", state: { revision: 2 } }, [
      { type: "json", value: { fire: false, state: { revision: 1 } } },
    ]),
    { kind: "evaluated", fire: true, message: "changed", state: { revision: 2 } },
  ],
  [
    "falls back to the last JSON entry",
    completed({ ignored: true }, [
      { type: "json", value: { fire: false, state: { old: true } } },
      { type: "text", text: "ignored" },
      { type: "json", value: { fire: true, state: { current: true } } },
    ]),
    { kind: "evaluated", fire: true, state: { current: true } },
  ],
  ["rejects a nonboolean fire", completed({ fire: "yes" }), INTERNAL_ERROR],
  ["rejects a nonstring message", completed({ fire: true, message: 42 }), INTERNAL_ERROR],
  [
    "rejects oversized state",
    completed({ fire: false, state: { value: "x".repeat(16 * 1024) } }),
    {
      kind: "error",
      code: "output_limit_exceeded",
      error: "cron trigger state exceeds the 16KB limit",
    },
  ],
] as const)("%s and injects trigger state", async (_name, result, expected) => {
  const { evaluate, runHeadless } = createEvaluator(result);
  await expect(evaluate({ state: { revision: 1 } })).resolves.toEqual(expected);
  expect(runHeadless).toHaveBeenCalledOnce();
  expect(runHeadless).toHaveBeenCalledWith(
    expect.objectContaining({
      extraNamespaces: triggerNamespace([["state", { revision: 1 }]]),
    }),
  );
});

it("starts cold after cancellation without waiting for the old preparation to settle", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const controller = new AbortController();
  let first = true;
  const { evaluate } = createEvaluator(undefined, {
    prepareRuntime: async (params) => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
        params.signal?.throwIfAborted();
      }
      return createPreparedRuntime(params.runtimeConfig);
    },
  });
  const cancelled = evaluate({ abortSignal: controller.signal });
  let next: ReturnType<typeof evaluate> | undefined;
  try {
    await entered.promise;
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ kind: "error", code: "aborted" });
    next = evaluate();
    release.resolve();
    await expect(next).resolves.toMatchObject({ kind: "evaluated", fire: false });
  } finally {
    controller.abort();
    release.resolve();
    await Promise.allSettled([cancelled, ...(next ? [next] : [])]);
  }
});

it.each(["policy change", "capacity eviction"] as const)(
  "retains an active runtime through %s and disposes it after its last evaluation",
  async (retirement) => {
    const entered = createDeferred();
    const release = createDeferred();
    const disposed: number[] = [];
    let generation = 0;
    const prepareRuntime: NonNullable<EvaluatorDeps["prepareRuntime"]> = async ({
      runtimeConfig,
    }) => {
      const current = ++generation;
      return {
        ...createPreparedRuntime(runtimeConfig, []),
        [Symbol.dispose]: () => disposed.push(current),
      };
    };
    let first = true;
    const { evaluate, prepareRuntime: prepare } = createEvaluator(
      async () => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return completed({ fire: false });
      },
      { prepareRuntime },
    );
    const active = evaluate();
    try {
      await entered.promise;
      if (retirement === "policy change") {
        await evaluate({ toolsAllow: [] });
        await evaluate({ toolsAllow: [] });
        expect(prepare).toHaveBeenCalledTimes(2);
      } else {
        for (let index = 0; index < 128; index++) {
          await evaluate({ jobId: `cache-${index}` });
        }
      }
      expect(disposed).toEqual([]);
      release.resolve();
      await expect(active).resolves.toMatchObject({ kind: "evaluated", fire: false });
      expect(disposed).toEqual([1]);
    } finally {
      release.resolve();
      await active;
    }
  },
);

it("returns busy instead of queueing a fourth concurrent evaluation", async () => {
  const pending = createDeferred<CodeModeHeadlessResult>();
  const runHeadless = vi.fn(async () => await pending.promise);
  const { evaluate } = createEvaluator(runHeadless);
  const running = ["one", "two", "three"].map((jobId) => evaluate({ jobId }));
  await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(3));

  const saturated = await evaluate({ jobId: "four" });
  pending.resolve(completed({ fire: false }));
  await Promise.all(running);

  expect(saturated).toEqual({ kind: "busy" });
  expect(runHeadless).toHaveBeenCalledTimes(3);
});

it.each(["preparation", "headless"] as const)("survives a clock jump during %s", async (phase) => {
  const now = Date.now();
  let jump = 0;
  const wallClock = vi.spyOn(Date, "now").mockImplementation(() => now + jump);
  try {
    const shiftClock = makeTool(
      "shift_clock",
      vi.fn(async () => {
        jump = 60_000;
        return jsonResult({ shifted: true });
      }),
    );
    const observeClock = makeTool(
      "observe_clock",
      vi.fn(async () => jsonResult({ observed: true })),
    );
    const { evaluate, runHeadless } = createEvaluator(
      async (params) =>
        phase === "headless" ? runCodeModeScriptHeadless(params) : completed({ fire: false }),
      {
        prepareRuntime: async ({ runtimeConfig }) => {
          if (phase === "preparation") {
            jump = 60_000;
            await Promise.resolve();
          }
          return createPreparedRuntime(runtimeConfig, [shiftClock, observeClock]);
        },
      },
    );
    await expect(
      evaluate({
        script:
          "await Promise.all([shift_clock({}), observe_clock({})]); await observe_clock({}); return { fire: true };",
      }),
    ).resolves.toMatchObject({ kind: "evaluated", fire: phase === "headless" });
    expect(runHeadless).toHaveBeenCalledOnce();
    if (phase === "preparation") {
      const delegatedBudgetMs = runHeadless.mock.calls[0]?.[0]?.wallClockMs;
      expect(Number.isSafeInteger(delegatedBudgetMs)).toBe(true);
      expect(delegatedBudgetMs).toBeGreaterThan(15_000);
      expect(delegatedBudgetMs).toBeLessThanOrEqual(30_000);
    } else {
      expect(shiftClock.execute).toHaveBeenCalledOnce();
      expect(observeClock.execute).toHaveBeenCalledTimes(2);
    }
  } finally {
    wallClock.mockRestore();
  }
});

it("uses payload-grade capped budgets and exposes frozen trigger state", async () => {
  const { executePayload, runHeadless } = createEvaluator(
    completed({
      notify: "queue changed",
      wake: "now",
      state: { revision: 2, dropped: undefined, nonFinite: Number.NaN },
      nextCheck: "5m",
    }),
  );

  await expect(
    executePayload({
      state: { revision: 1 },
      streamBatch: "line one\nline two",
      timeoutSeconds: 10_000,
      toolBudget: 10_000,
    }),
  ).resolves.toEqual({
    kind: "completed",
    notify: "queue changed",
    wake: "now",
    stateChanged: true,
    state: { revision: 2, nonFinite: null },
    nextCheck: { delayMs: 300_000 },
  });
  expect(runHeadless).toHaveBeenCalledWith(
    expect.objectContaining({
      maxToolCalls: 200,
      extraNamespaces: triggerNamespace([
        ["state", { revision: 1 }],
        ["streamBatch", "line one\nline two"],
      ]),
    }),
  );
  const headlessParams = runHeadless.mock.calls[0]?.[0];
  expect(headlessParams?.wallClockMs).toBeGreaterThanOrEqual(899_000);
  expect(headlessParams?.wallClockMs).toBeLessThanOrEqual(900_000);
});

it.each([
  [{ notify: 42 }, "notify must be a string"],
  [{ wake: "later" }, 'wake must be "now" or "next-heartbeat"'],
  [{ nextCheck: "tomorrowish" }, "nextCheck must be a positive duration"],
  [{ state: "x".repeat(17 * 1024) }, "state exceeds the 16KB limit"],
] as const)("rejects an invalid result %#", async (value, error) => {
  const runtime = createEvaluator(completed(value));

  await expect(runtime.executePayload()).resolves.toMatchObject({
    kind: "error",
    error: expect.stringContaining(error),
  });
});

function toolRuntime(ctx: ToolSearchToolContext) {
  return new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.runtimeConfig), {
    prepareInput: true,
    validateInput: true,
  });
}

function authorityFixture(
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
      return completed(
        { fire: false, state: await toolRuntime(ctx).callValue("probe", {}) },
        [],
        1,
      );
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
  const { runtime, prepare, admitted, retained, input } = authorityFixture(async () => {
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
    expect(retained[index]?.catalogRef?.onDispose).toBeUndefined();
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
    const { runtime, admitted, input } = authorityFixture(
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
  const { runtime, prepare, admitted, input } = authorityFixture(async () => {
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
