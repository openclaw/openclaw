import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { runCodeModeScriptHeadless, type CodeModeHeadlessResult } from "../agents/code-mode.js";
import { clearToolSearchCatalog } from "../agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

type EvaluatorDeps = Parameters<typeof createCronScriptRuntime>[0];
type HeadlessParams = Parameters<NonNullable<EvaluatorDeps["runHeadless"]>>[0];
type PrepareParams = Parameters<NonNullable<EvaluatorDeps["prepareRuntime"]>>[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function completed(value: unknown, output: unknown[] = []): CodeModeHeadlessResult {
  return { status: "completed", value, output, toolCallCount: 0 };
}

function createPreparedRuntime(config: OpenClawConfig) {
  const tool = wrapToolWithBeforeToolCallHook(
    {
      name: "probe",
      label: "Probe",
      description: "Probe tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    } satisfies AnyAgentTool,
    { config, agentId: "main", sessionKey: "cron:test:trigger" },
  );
  return {
    createTools: async () => [tool],
    context: { config, agentId: "main", sessionKey: "cron:test:trigger" },
  };
}

function createEvaluator(
  result: CodeModeHeadlessResult | NonNullable<EvaluatorDeps["runHeadless"]>,
) {
  const config: OpenClawConfig = {};
  const runHeadless = vi.fn(async (params: HeadlessParams) =>
    typeof result === "function" ? result(params) : result,
  );
  const prepareRuntime = vi.fn(async () => createPreparedRuntime(config));
  const runtime = createCronScriptRuntime({ config, runHeadless, prepareRuntime });
  return {
    ...runtime,
    evaluate: runtime.evaluateTrigger,
    prepareRuntime,
    runHeadless,
  };
}

function createCronTriggerEvaluator(deps: EvaluatorDeps) {
  return createCronScriptRuntime(deps).evaluateTrigger;
}

const INPUT = { jobId: "probe", script: "return result", state: null };

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

function shiftedWallClock() {
  const now = Date.now();
  let jump = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now + jump);
  return {
    shift: () => {
      jump = 60_000;
    },
    restore: () => spy.mockRestore(),
  };
}

describe("cron trigger script evaluator", () => {
  it("cancels the real headless worker and bridge when its evaluation catalog closes", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const config: OpenClawConfig = {};
    let context: HeadlessParams["ctx"] | undefined;
    let aborts = 0;
    const prepared = createPreparedRuntime(config);
    const gate: AnyAgentTool = {
      ...(await prepared.createTools())[0],
      name: "gate",
      label: "Gate",
      description: "Wait for the local fixture",
      parameters: { type: "object", properties: {} },
      async execute(_id, _args, signal) {
        signal?.addEventListener(
          "abort",
          () => {
            aborts += 1;
          },
          { once: true },
        );
        entered.resolve();
        await release.promise;
        return jsonResult(true);
      },
    };
    const runtime = createCronScriptRuntime({
      config,
      prepareRuntime: async () => ({ ...prepared, createTools: async () => [gate] }),
      runHeadless: (params) => {
        context = params.ctx;
        return runCodeModeScriptHeadless(params);
      },
    });
    const evaluation = runtime.evaluateTrigger({
      ...INPUT,
      jobId: "catalog-close",
      script: 'await gate({}); text("STALE AFTER CLOSE"); return { fire: true };',
    });
    try {
      await entered.promise;
      if (!context) {
        throw new Error("Expected the real headless context");
      }
      expect(context.abortSignal?.aborted).toBe(false);
      clearToolSearchCatalog(context);
      expect(aborts).toBe(1);
      await expect(evaluation).resolves.toMatchObject({ kind: "error", code: "aborted" });
      expect(context.catalogRef?.onDispose).toBeUndefined();
      release.resolve();
      await expect(
        runtime.evaluateTrigger({
          ...INPUT,
          jobId: "catalog-close",
          script: "return { fire: false };",
        }),
      ).resolves.toMatchObject({ kind: "evaluated", fire: false });
      expect(context.catalogRef?.onDispose?.size ?? 0).toBe(0);
    } finally {
      release.resolve();
      await evaluation;
    }
  });

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
      jobId: "acp-workspace-trigger",
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
      const workspaceDir = tempDirs.make("openclaw-cron-canonical-cap-");
      // Automatic placement must honor the pin despite the script's node request;
      // an explicit current node restriction must reject the captured Gateway host.
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: workspaceDir } },
        tools: {
          exec: {
            host,
            node: "configured-node-must-not-run",
            security: "full",
            ask: "off",
          },
        },
      };
      const evaluate = createCronScriptRuntime({ config }).evaluateTrigger;

      await expect(
        evaluate({
          ...INPUT,
          jobId: "job-canonical-pinned-exec",
          script:
            'await exec({ command: "printf openclaw-canonical-ok", host: "node", node: "remote" }); return { fire: false };',
          toolsAllow: ["exec", "process"],
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          execTarget: { version: 1, host: "gateway" },
        }),
      ).resolves.toEqual(expected);
    },
  );

  it("keeps an uncanonicalized alias-name cap fail-closed for exec", async () => {
    const workspaceDir = tempDirs.make("openclaw-cron-alias-collision-");
    const evaluate = createCronScriptRuntime({
      config: {
        agents: { defaults: { workspace: workspaceDir } },
        tools: { exec: { host: "gateway", security: "full", ask: "off" } },
      } as OpenClawConfig,
    }).evaluateTrigger;

    const result = await evaluate({
      ...INPUT,
      jobId: "job-colliding-gateway-exec",
      script: 'await exec({ command: "printf must-not-run" }); return { fire: false };',
      toolsAllow: ["gateway_exec"],
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });

    expect(result).toMatchObject({ kind: "error", code: "internal_error" });
    expect(result.kind === "error" ? result.error : "").toContain("exec is not defined");
  });

  it("prefers a valid returned value and injects trigger state", async () => {
    const { evaluate, runHeadless } = createEvaluator(
      completed({ fire: true, message: "changed", state: { revision: 2 } }, [
        { type: "json", value: { fire: false, state: { revision: 1 } } },
      ]),
    );

    await expect(
      evaluate({ ...INPUT, jobId: "job-value", state: { revision: 1 } }),
    ).resolves.toEqual({
      kind: "evaluated",
      fire: true,
      message: "changed",
      state: { revision: 2 },
    });
    expect(runHeadless).toHaveBeenCalledOnce();
    expect(runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        extraNamespaces: triggerNamespace([["state", { revision: 1 }]]),
      }),
    );
  });

  it("falls back to the last json output entry when the returned object is not a trigger result", async () => {
    const { evaluate } = createEvaluator(
      completed({ ignored: true }, [
        { type: "json", value: { fire: false, state: { old: true } } },
        { type: "text", text: "ignored" },
        { type: "json", value: { fire: true, state: { current: true } } },
      ]),
    );

    await expect(
      evaluate({ ...INPUT, jobId: "job-json", script: "json(result)" }),
    ).resolves.toEqual({
      kind: "evaluated",
      fire: true,
      state: { current: true },
    });
  });

  it("starts cold after cancellation without waiting for the old preparation to settle", async () => {
    const config: OpenClawConfig = {};
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    let first = true;
    const evaluate = createCronTriggerEvaluator({
      config,
      prepareRuntime: async (params) => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
          params.signal?.throwIfAborted();
        }
        return createPreparedRuntime(config);
      },
      runHeadless: async () => completed({ fire: false }),
    });
    const input = { ...INPUT, jobId: "cancelled-preparation", script: "return {}" };
    const cancelled = evaluate({ ...input, abortSignal: controller.signal });
    let next: ReturnType<typeof evaluate> | undefined;
    try {
      await entered.promise;
      controller.abort();
      await expect(cancelled).resolves.toMatchObject({ kind: "error", code: "aborted" });
      next = evaluate(input);
      release.resolve();
      await expect(next).resolves.toMatchObject({ kind: "evaluated", fire: false });
    } finally {
      controller.abort();
      release.resolve();
      await Promise.allSettled([cancelled, ...(next ? [next] : [])]);
    }
  });

  it("forwards scheduled provenance and invalidates cached authority when it changes", async () => {
    const config: OpenClawConfig = {};
    const prepareRuntime = vi.fn(async (_params: PrepareParams) => createPreparedRuntime(config));
    const runHeadless = vi.fn(async () => completed({ fire: false }));
    const evaluate = createCronTriggerEvaluator({ config, prepareRuntime, runHeadless });

    const policies = (
      [
        ["agent:main:discord:group:a", "alpha"],
        ["agent:main:discord:group:b", "beta"],
      ] as const
    ).map(([ownerSessionKey, ownerAccountId]) => ({
      version: 1 as const,
      mode: "account" as const,
      ownerSessionKey,
      ownerAccountId,
    }));
    for (const scheduledToolPolicy of policies) {
      await evaluate({
        ...INPUT,
        jobId: "job-owner-session",
        toolsAllow: ["write"],
        scheduledToolPolicy,
      });
    }

    expect(prepareRuntime.mock.calls.map(([params]) => params.scheduledToolPolicy)).toEqual(
      policies,
    );
  });

  it.each(["policy change", "capacity eviction"] as const)(
    "retains an active runtime through %s and disposes it after its last evaluation",
    async (retirement) => {
      const config: OpenClawConfig = {};
      const entered = createDeferred();
      const release = createDeferred();
      const disposed: number[] = [];
      let generation = 0;
      const prepareRuntime = vi.fn(async () => {
        const current = ++generation;
        return {
          ...createPreparedRuntime(config),
          createTools: async () => [],
          [Symbol.dispose]: () => disposed.push(current),
        };
      });
      let first = true;
      const evaluate = createCronTriggerEvaluator({
        config,
        prepareRuntime,
        runHeadless: async () => {
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
          }
          return completed({ fire: false });
        },
      });
      const input = { ...INPUT, jobId: "active-cache", script: "return {}" };
      const active = evaluate(input);
      try {
        await entered.promise;
        if (retirement === "policy change") {
          await evaluate({ ...input, toolsAllow: [] });
          await evaluate({ ...input, toolsAllow: [] });
          expect(prepareRuntime).toHaveBeenCalledTimes(2);
        } else {
          for (let index = 0; index < 128; index++) {
            await evaluate({ ...input, jobId: `cache-${index}` });
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

  it.each([completed({ fire: "yes" }), completed({ fire: true, message: 42 })])(
    "rejects invalid result shapes",
    async (headlessResult) => {
      const { evaluate } = createEvaluator(headlessResult);

      const result = await evaluate({ ...INPUT, jobId: "job-invalid", script: "return bad" });

      expect(result).toMatchObject({ kind: "error", code: "internal_error" });
    },
  );

  it("rejects returned state larger than 16KB", async () => {
    const { evaluate } = createEvaluator(
      completed({ fire: false, state: { value: "x".repeat(16 * 1024) } }),
    );

    await expect(evaluate({ ...INPUT, jobId: "job-large-state" })).resolves.toEqual({
      kind: "error",
      code: "output_limit_exceeded",
      error: "cron trigger state exceeds the 16KB limit",
    });
  });

  it("returns busy instead of queueing a fourth concurrent evaluation", async () => {
    const pending = createDeferred<CodeModeHeadlessResult>();
    const runHeadless = vi.fn(async () => await pending.promise);
    const { evaluate } = createEvaluator(runHeadless);
    const running = ["one", "two", "three"].map((jobId) => evaluate({ ...INPUT, jobId }));
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(3));

    const saturated = await evaluate({ ...INPUT, jobId: "four" });
    pending.resolve(completed({ fire: false }));
    await Promise.all(running);

    expect(saturated).toEqual({ kind: "busy" });
    expect(runHeadless).toHaveBeenCalledTimes(3);
  });
});

describe("cron script runtime elapsed-time budgets", () => {
  it("preserves an integer elapsed-time budget when the wall clock jumps during preparation", async () => {
    const config: OpenClawConfig = {};
    const wallClock = shiftedWallClock();
    try {
      const prepareRuntime = vi.fn(async () => {
        wallClock.shift();
        await Promise.resolve();
        return createPreparedRuntime(config);
      });
      const runHeadless = vi.fn(async (_params: HeadlessParams) => completed({ fire: false }));
      const runtime = createCronScriptRuntime({ config, prepareRuntime, runHeadless });
      await expect(
        runtime.evaluateTrigger({
          ...INPUT,
          jobId: "wall-clock-trigger",
          script: "return { fire: false }",
        }),
      ).resolves.toMatchObject({ kind: "evaluated", fire: false });
      expect(runHeadless).toHaveBeenCalledOnce();
      const delegatedBudgetMs = runHeadless.mock.calls[0]?.[0]?.wallClockMs;
      expect(Number.isSafeInteger(delegatedBudgetMs)).toBe(true);
      expect(delegatedBudgetMs).toBeGreaterThan(15_000);
      expect(delegatedBudgetMs).toBeLessThanOrEqual(30_000);
    } finally {
      wallClock.restore();
    }
  });

  it("survives a wall-clock jump after the real headless handoff", async () => {
    const config: OpenClawConfig = {};
    const wallClock = shiftedWallClock();
    try {
      const shiftClock = {
        name: "shift_clock",
        label: "Shift clock",
        description: "Adjust the test wall clock",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(async () => {
          wallClock.shift();
          return jsonResult({ shifted: true });
        }),
      } satisfies AnyAgentTool;
      const observeClock = {
        ...shiftClock,
        name: "observe_clock",
        execute: vi.fn(async () => jsonResult({ observed: true })),
      } satisfies AnyAgentTool;
      const runtime = createCronScriptRuntime({
        config,
        prepareRuntime: async () => ({
          ...createPreparedRuntime(config),
          createTools: async () => [shiftClock, observeClock],
        }),
      });
      await expect(
        runtime.evaluateTrigger({
          ...INPUT,
          jobId: "real-headless-trigger",
          script:
            "await Promise.all([shift_clock({}), observe_clock({})]); await observe_clock({}); return { fire: true };",
        }),
      ).resolves.toMatchObject({ kind: "evaluated", fire: true });
      expect(shiftClock.execute).toHaveBeenCalledOnce();
      expect(observeClock.execute).toHaveBeenCalledTimes(2);
    } finally {
      wallClock.restore();
    }
  });
});

describe("cron script payload evaluator", () => {
  it("uses payload-grade capped budgets and exposes frozen trigger state", async () => {
    const runtime = createEvaluator(
      completed({
        notify: "queue changed",
        wake: "now",
        state: { revision: 2, dropped: undefined, nonFinite: Number.NaN },
        nextCheck: "5m",
      }),
    );
    const { runHeadless } = runtime;

    await expect(
      runtime.executePayload({
        ...INPUT,
        jobId: "payload-job",
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

    await expect(
      runtime.executePayload({ ...INPUT, jobId: "payload-invalid" }),
    ).resolves.toMatchObject({ kind: "error", error: expect.stringContaining(error) });
  });
});
