import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../extensions/lobster/index.js";
import type { createRuntimeTasks } from "../../src/plugins/runtime/runtime-tasks.js";
import { waitForFixtureFile } from "../helpers/process-wait.js";

type RuntimeTasks = ReturnType<typeof createRuntimeTasks>;
type BoundTaskFlow = ReturnType<RuntimeTasks["async"]["managedFlows"]["bindSession"]> &
  Pick<ReturnType<RuntimeTasks["managedFlows"]["bindSession"]>, "cancel">;
type ToolResult = Awaited<ReturnType<AnyAgentTool["execute"]>>;

const requireRecord = createRequireRecord("record", "expected-label-record");
const owner = "agent:main:managed-lobster-input";
const responseSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["publish", "revise"] },
    ["__proto__"]: { type: "string", title: "Literal JSON property" },
  },
  required: ["decision"],
  additionalProperties: false,
};

let fixtureDir: string;
let closeStateDatabase: (() => Promise<void>) | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabase?.();
    closeStateDatabase = undefined;
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function bindFreshRuntime(sessionKey = owner) {
  const { createRuntimeTaskFlow } = await import("../../src/plugins/runtime/runtime-taskflow.js");
  const { createRuntimeTasks } = await import("../../src/plugins/runtime/runtime-tasks.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  closeStateDatabase = closeOpenClawStateDatabaseAsync;
  const tasks = createRuntimeTasks({ managedTaskFlow: createRuntimeTaskFlow() });
  return {
    ...tasks.async.managedFlows.bindSession({ sessionKey }),
    cancel: tasks.managedFlows.bindSession({ sessionKey }).cancel,
  };
}

function createTool(taskFlow: BoundTaskFlow) {
  const runtime = createPluginRuntimeMock();
  const ctx = { config: {}, sessionKey: taskFlow.sessionKey, sandboxed: false };
  const legacy = runtime.tasks.managedFlows.fromToolContext(ctx);
  vi.mocked(runtime.tasks.async.managedFlows.fromToolContext).mockReturnValue(taskFlow);
  vi.mocked(runtime.tasks.managedFlows.fromToolContext).mockReturnValue({
    ...legacy,
    cancel: taskFlow.cancel,
  });
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  plugin.register(createTestPluginApi({ id: "lobster", runtime, registerTool }));
  const factory = registerTool.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("Expected the registered Lobster tool factory");
  }
  const tool = factory(ctx);
  if (!tool || Array.isArray(tool)) {
    throw new Error("Expected a bound Lobster tool");
  }
  return tool;
}

function pauseClaimRead(taskFlow: BoundTaskFlow) {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let paused = false;
  return {
    entered,
    release,
    taskFlow: {
      ...taskFlow,
      async get(flowId: string) {
        const flow = await taskFlow.get(flowId);
        if (!paused && flow?.status === "running") {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return flow;
      },
    },
  };
}

function flowResult(result: ToolResult) {
  const details = requireRecord(result.details, "managed Lobster result");
  expect(details.flow, JSON.stringify(details)).toBeTypeOf("object");
  const flow = requireRecord(details.flow, "managed Lobster flow");
  if (typeof flow.flowId !== "string" || typeof flow.revision !== "number") {
    throw new Error("Expected a persisted flow ID and revision");
  }
  return { details, flow, flowId: flow.flowId, revision: flow.revision };
}

async function expectRejected(operation: Promise<ToolResult>) {
  const outcome = await operation.then(
    (result) => ({ kind: "result" as const, result }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  if (outcome.kind === "error") {
    expect(outcome.error).toBeInstanceOf(Error);
  } else {
    expect(outcome.result).toMatchObject({ isError: true });
  }
}

async function writeWorkflow(
  options: {
    chained?: boolean;
    failAfterInput?: boolean;
    prompt?: string;
    chainedPrompt?: string;
  } = {},
) {
  const filePath = path.join(fixtureDir, "review.lobster");
  const effectsPath = path.join(fixtureDir, "effects.log");
  const scriptPath = path.join(fixtureDir, "workflow-step.cjs");
  await fs.writeFile(
    scriptPath,
    [
      "const fs = require('node:fs');",
      "const phase = process.env.PHASE;",
      "fs.appendFileSync(process.env.EFFECTS, phase + String.fromCharCode(10));",
      "if (phase === 'draft') {",
      "  process.stdout.write(JSON.stringify({text:'draft'}));",
      "} else {",
      "  if (process.env.FAIL_AFTER_INPUT === 'true') process.exit(7);",
      "  process.stdout.write(JSON.stringify({decision:process.env.DECISION,subject:process.env.SUBJECT,cwd:process.cwd()}));",
      "}",
    ].join("\n"),
    "utf8",
  );
  // File-backed scripts avoid incompatible JSON-string escaping in POSIX shells and cmd.exe.
  const run = `"${process.execPath}" "${scriptPath}"`;
  await fs.writeFile(
    filePath,
    JSON.stringify({
      steps: [
        {
          id: "draft",
          run,
          env: { EFFECTS: effectsPath, PHASE: "draft" },
        },
        {
          id: "review",
          input: {
            prompt: options.prompt ?? "Publish or revise the draft?",
            responseSchema,
            defaults: { decision: "revise" },
          },
        },
        ...(options.chained
          ? [
              {
                id: "confirmation",
                input: {
                  prompt: options.chainedPrompt ?? "Confirm?",
                  responseSchema: { type: "boolean" },
                },
              },
            ]
          : []),
        {
          id: "finish",
          run,
          env: {
            EFFECTS: effectsPath,
            PHASE: "finish",
            FAIL_AFTER_INPUT: String(Boolean(options.failAfterInput)),
            DECISION: "$review.response.decision",
            SUBJECT: "$review.subject.text",
          },
        },
      ],
    }),
    "utf8",
  );
  return { filePath, effectsPath };
}

function runParams(filePath: string) {
  return {
    action: "run",
    pipeline: filePath,
    cwd: "extensions/lobster",
    flowControllerId: "tests/lobster-input",
    flowGoal: "Review a draft without losing its pending input",
  };
}

beforeEach(async () => {
  vi.resetModules();
  fixtureDir = tempDirs.make("lobster-managed-input-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureDir, "openclaw"));
  vi.stubEnv("LOBSTER_STATE_DIR", path.join(fixtureDir, "lobster"));
});

describe("managed Lobster structured input", () => {
  it.each(["run", "resume"] as const)(
    "stops embedded workflow effects when %s is aborted",
    async (action) => {
      const taskFlow = await bindFreshRuntime();
      const filePath = path.join(fixtureDir, "abort.lobster");
      const effectsPath = path.join(fixtureDir, "abort-effects.log");
      const scriptPath = path.join(fixtureDir, "slow-step.cjs");
      await fs.writeFile(
        scriptPath,
        [
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.env.EFFECTS + '.tmp', 'started\\n');",
          "fs.renameSync(process.env.EFFECTS + '.tmp', process.env.EFFECTS);",
          "setTimeout(() => {",
          "  fs.appendFileSync(process.env.EFFECTS, 'finished\\n');",
          "  process.stdout.write('{}');",
          "}, 2000);",
        ].join("\n"),
      );
      await fs.writeFile(
        filePath,
        JSON.stringify({
          steps: [
            ...(action === "resume"
              ? [
                  {
                    id: "review",
                    input: { prompt: "Continue?", responseSchema: { type: "boolean" } },
                  },
                ]
              : []),
            {
              id: "slow",
              run: `"${process.execPath}" "${scriptPath}"`,
              env: { EFFECTS: effectsPath },
            },
          ],
        }),
      );
      const controller = new AbortController();
      const tool = createTool(taskFlow);
      const first =
        action === "resume"
          ? flowResult(await tool.execute("pause", runParams(filePath)))
          : undefined;
      const args = first
        ? {
            action: "resume",
            flowId: first.flowId,
            flowExpectedRevision: first.revision,
            responseJson: "true",
          }
        : runParams(filePath);
      const pending = tool.execute("abort-probe", args, controller.signal);
      try {
        await waitForFixtureFile(effectsPath, pending, "started\n");
        expect(await fs.readFile(effectsPath, "utf8")).toBe("started\n");
        controller.abort(new Error("caller stopped the tool"));
        const result = await pending;
        expect(result).toMatchObject({ isError: true });
        expect(flowResult(result).flow.status).toBe("failed");
        // Wait beyond the fixture's effect deadline: an error response alone does
        // not prove that the subprocess stopped producing effects.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2200);
        });
        expect(await fs.readFile(effectsPath, "utf8")).toBe("started\n");
      } finally {
        controller.abort();
        await Promise.allSettled([pending]);
      }
    },
  );

  it("rediscovers a durable wait after reopening state and resumes without a context token", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
    expect(first.details.status).toBe("needs_input");
    expect(first.flow.status).toBe("waiting");
    expect(first.flow.waitJson).toMatchObject({
      kind: "lobster_input",
      prompt: "Publish or revise the draft?",
      responseSchema,
      defaults: { decision: "revise" },
      subject: { text: "draft" },
      resumeToken: expect.any(String),
      cwd: path.join(process.cwd(), "extensions/lobster"),
    });
    const wait = requireRecord(first.flow.waitJson, "persisted input wait");
    const schema = requireRecord(wait.responseSchema, "persisted input schema");
    const properties = requireRecord(schema.properties, "persisted schema properties");
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toEqual({
      type: "string",
      title: "Literal JSON property",
    });
    expect(await taskFlow.get(first.flowId)).toEqual(first.flow);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");

    // Discard the in-memory registry, not the database, before creating a new tool context.
    await closeStateDatabase?.();
    vi.resetModules();
    const later = Date.now() + 30 * 24 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const reopened = await bindFreshRuntime();
    const newTool = createTool(reopened);
    const status = flowResult(
      await newTool.execute("find-wait", { action: "status", flowId: first.flowId }),
    );
    expect(status.flow).toMatchObject({
      flowId: first.flowId,
      revision: first.revision,
      status: "waiting",
      waitJson: first.flow.waitJson,
    });
    expect(await reopened.get(first.flowId)).toEqual(first.flow);
    const pending = requireRecord(
      (await newTool.execute("pending", { action: "status" })).details,
      "pending flows",
    );
    expect(pending.flows).toEqual([
      expect.objectContaining({
        flowId: first.flowId,
        revision: first.revision,
        status: "waiting",
      }),
    ]);

    const finished = flowResult(
      await newTool.execute("answer", {
        action: "resume",
        flowId: status.flowId,
        flowExpectedRevision: status.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    expect(finished.details).toMatchObject({
      status: "ok",
      output: [
        {
          decision: "publish",
          subject: "draft",
          cwd: path.join(process.cwd(), "extensions/lobster"),
        },
      ],
    });
    expect(finished.flow.status).toBe("succeeded");
    expect(finished.flow.waitJson).toBeNull();
    expect(await reopened.get(first.flowId)).toEqual(finished.flow);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it("keeps a schema-invalid answer correctable at the new revision without rerunning earlier work", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const invalid = await tool.execute("invalid-answer", {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: 42 }),
    });
    expect(invalid).toMatchObject({ isError: true });
    const retry = flowResult(invalid);
    expect(retry.details.ok).toBe(false);
    expect(retry.flow.status).toBe("waiting");
    expect(retry.flow.waitJson).toEqual(first.flow.waitJson);
    expect(retry.revision).toBeGreaterThan(first.revision);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");

    const corrected = flowResult(
      await createTool(await bindFreshRuntime()).execute("correct-answer", {
        action: "resume",
        flowId: retry.flowId,
        flowExpectedRevision: retry.revision,
        responseJson: JSON.stringify({ decision: "revise" }),
      }),
    );
    expect(corrected.flow.status).toBe("succeeded");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it("recovers an inline input wait after an invalid answer and resumes its remaining pipeline", async () => {
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(
      await tool.execute(
        "inline-input",
        runParams(
          `ask --prompt 'Review?' --schema '${JSON.stringify(responseSchema)}' | pick decision`,
        ),
      ),
    );
    expect(first.details.status).toBe("needs_input");
    expect(first.flow.waitJson).toMatchObject({ kind: "lobster_input", responseSchema });
    const invalid = await tool.execute("invalid-inline-answer", {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: 42 }),
    });
    expect(invalid).toMatchObject({ isError: true });
    const retry = flowResult(invalid);
    expect(retry.flow.status).toBe("waiting");
    expect(retry.flow.waitJson).toEqual(first.flow.waitJson);
    expect(retry.revision).toBeGreaterThan(first.revision);
    const finished = flowResult(
      await createTool(await bindFreshRuntime()).execute("correct-inline-answer", {
        action: "resume",
        flowId: retry.flowId,
        flowExpectedRevision: retry.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    expect(finished.details).toMatchObject({ status: "ok", output: [{ decision: "publish" }] });
    expect(finished.flow.status).toBe("succeeded");
    expect(finished.flow.waitJson).toBeNull();
    expect(await taskFlow.get(first.flowId)).toEqual(finished.flow);
  });

  it("rejects foreign owners, stale revisions, substituted tokens, and terminal replay without consuming the checkpoint", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
    const answer = {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: "publish" }),
    };
    await expectRejected(
      createTool(await bindFreshRuntime("agent:main:foreign-owner")).execute("foreign", answer),
    );
    await expectRejected(
      createTool(taskFlow).execute("stale", {
        ...answer,
        flowExpectedRevision: first.revision - 1,
      }),
    );
    await expectRejected(
      createTool(taskFlow).execute("substitution", {
        ...answer,
        token: "unrelated-resume-token",
      }),
    );
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
    expect(await taskFlow.get(first.flowId)).toEqual(first.flow);

    const finished = flowResult(await createTool(taskFlow).execute("answer", answer));
    await expectRejected(createTool(taskFlow).execute("duplicate", answer));
    await expectRejected(
      createTool(taskFlow).execute("terminal", {
        ...answer,
        flowExpectedRevision: finished.revision,
      }),
    );
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
    expect(await taskFlow.get(first.flowId)).toEqual(finished.flow);
  });

  it("lets only one simultaneous answer claim and execute the checkpoint", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
    const paused = pauseClaimRead(taskFlow);
    const tool = createTool(paused.taskFlow);
    const answer = {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: "publish" }),
    };
    const winner = tool.execute("first-answer", answer);
    await paused.entered.promise;
    try {
      await expectRejected(createTool(taskFlow).execute("concurrent-answer", answer));
      expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
    } finally {
      paused.release.resolve();
    }
    expect(flowResult(await winner).flow.status).toBe("succeeded");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it("does not claim a newer revision using a checkpoint from an earlier awaited read", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let firstRead = true;
    const tool = createTool({
      ...taskFlow,
      async get(flowId) {
        const flow = await taskFlow.get(flowId);
        if (firstRead) {
          firstRead = false;
          entered.resolve();
          await release.promise;
        }
        return flow;
      },
    });
    const pending = tool.execute("stale-checkpoint-read", {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision + 1,
      responseJson: JSON.stringify({ decision: "publish" }),
    });
    await entered.promise;
    let successor: Awaited<ReturnType<BoundTaskFlow["get"]>>;
    try {
      const updated = await taskFlow.setWaiting({
        flowId: first.flowId,
        expectedRevision: first.revision,
        waitJson: {
          kind: "lobster_input",
          prompt: "A newer question",
          responseSchema,
          resumeToken: "newer-checkpoint",
          cwd: path.join(process.cwd(), "extensions/lobster"),
        },
      });
      expect(updated.applied).toBe(true);
      if (!updated.applied) {
        throw new Error("Expected the newer wait to be persisted");
      }
      successor = updated.flow;
    } finally {
      release.resolve();
    }
    await expectRejected(Promise.resolve(pending));
    expect(await taskFlow.get(first.flowId)).toEqual(successor);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
  });

  it.each([
    { scenario: "settles a cancellation-only successor", advanceRevision: false },
    { scenario: "does not cancel a newer successor", advanceRevision: true },
  ])(
    "$scenario when cancellation arrives during an awaited claim read",
    async ({ advanceRevision }) => {
      const { filePath, effectsPath } = await writeWorkflow();
      const taskFlow = await bindFreshRuntime();
      const first = flowResult(await createTool(taskFlow).execute("start", runParams(filePath)));
      const paused = pauseClaimRead(taskFlow);
      const pending = createTool(paused.taskFlow).execute("answer", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      });
      await paused.entered.promise;
      let successor: Awaited<ReturnType<BoundTaskFlow["get"]>>;
      try {
        const claimed = await taskFlow.get(first.flowId);
        expect(claimed?.status).toBe("running");
        expect(claimed?.revision).toBe(first.revision + 1);
        if (!claimed) {
          throw new Error("Expected the active managed flow claim");
        }
        const cancellation = await taskFlow.requestCancel({
          flowId: first.flowId,
          expectedRevision: claimed.revision,
        });
        expect(cancellation.applied).toBe(true);
        if (!cancellation.applied) {
          throw new Error("Expected the cancellation request to be persisted");
        }
        successor = cancellation.flow;
        if (advanceRevision) {
          // A subsequent owner mutation is not the cancellation-only successor of this runner.
          const updated = await taskFlow.resume({
            flowId: first.flowId,
            expectedRevision: cancellation.flow.revision,
            status: "running",
            stateJson: { successor: true },
          });
          expect(updated.applied).toBe(true);
          if (!updated.applied) {
            throw new Error("Expected the newer owner revision to be persisted");
          }
          successor = updated.flow;
        }
      } finally {
        paused.release.resolve();
      }

      const result = await pending;
      expect(result).toMatchObject({ isError: true });
      expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
      if (advanceRevision) {
        expect(await taskFlow.get(first.flowId)).toEqual(successor);
        expect(successor?.status).toBe("running");
      } else {
        const cancelled = flowResult(result);
        expect(cancelled.flow.status).toBe("cancelled");
        expect(await taskFlow.get(first.flowId)).toEqual(cancelled.flow);
      }
    },
  );

  it("rotates chained input checkpoints and accepts a false JSON answer", async () => {
    const { filePath, effectsPath } = await writeWorkflow({ chained: true });
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const second = flowResult(
      await tool.execute("first-answer", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    expect(second.details.status).toBe("needs_input");
    expect(second.flow.waitJson).toMatchObject({
      kind: "lobster_input",
      prompt: "Confirm?",
      responseSchema: { type: "boolean" },
    });
    const firstWait = requireRecord(first.flow.waitJson, "first input wait");
    const secondWait = requireRecord(second.flow.waitJson, "second input wait");
    expect(secondWait.resumeToken).not.toBe(firstWait.resumeToken);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
    await expectRejected(
      tool.execute("old-answer", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    const finished = flowResult(
      await tool.execute("second-answer", {
        action: "resume",
        flowId: second.flowId,
        flowExpectedRevision: second.revision,
        responseJson: "false",
      }),
    );
    expect(finished.flow.status).toBe("succeeded");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it("cancels an input checkpoint without executing downstream work", async () => {
    const { filePath, effectsPath } = await writeWorkflow();
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const cancelled = flowResult(
      await tool.execute("cancel", {
        action: "resume",
        flowId: first.flowId,
        flowExpectedRevision: first.revision,
        cancel: true,
      }),
    );
    expect(cancelled.details.status).toBe("cancelled");
    expect(cancelled.flow.status).toBe("cancelled");
    expect((await taskFlow.get(first.flowId))?.status).toBe("cancelled");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
    const wait = requireRecord(first.flow.waitJson, "cancelled input wait");
    expect(typeof wait.resumeToken).toBe("string");
    if (typeof wait.resumeToken !== "string") {
      throw new Error("Expected the cancelled checkpoint token");
    }
    // A saved token must not make structured input available through ordinary mode.
    await expect(
      createTool(taskFlow).execute("replay-cancelled-checkpoint", {
        action: "resume",
        token: wait.resumeToken,
        responseJson: JSON.stringify({ decision: "publish" }),
        cwd: "extensions/lobster",
        timeoutMs: 2000,
        maxStdoutBytes: 4096,
      }),
    ).rejects.toThrow();
    // Bypass the host's ordinary-mode refusal: the dependency must invalidate
    // the saved capability too, including for another process using its public API.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { resumeToolRequest } from "@clawdbot/lobster/core";',
          'const result = await resumeToolRequest({ token: process.argv[1], response: { decision: "publish" } });',
          "process.stdout.write(JSON.stringify(result));",
        ].join("\n"),
        wait.resumeToken,
      ],
      { cwd: path.join(process.cwd(), "extensions/lobster"), timeout: 5000 },
    );
    const replay: unknown = JSON.parse(stdout);
    expect(replay).toMatchObject({ ok: false, error: { type: "runtime_error" } });
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");
  });

  it("records an execution failure after an input answer and never automatically replays effects", async () => {
    const { filePath, effectsPath } = await writeWorkflow({ failAfterInput: true });
    const taskFlow = await bindFreshRuntime();
    const tool = createTool(taskFlow);
    const first = flowResult(await tool.execute("start", runParams(filePath)));
    const failed = await tool.execute("answer", {
      action: "resume",
      flowId: first.flowId,
      flowExpectedRevision: first.revision,
      responseJson: JSON.stringify({ decision: "publish" }),
    });
    expect(failed).toMatchObject({ isError: true });
    const current = flowResult(failed);
    expect(current.flow.status).toBe("failed");
    expect(current.flow.waitJson).toBeNull();
    await expectRejected(
      createTool(await bindFreshRuntime()).execute("retry", {
        action: "resume",
        flowId: current.flowId,
        flowExpectedRevision: current.revision,
        responseJson: JSON.stringify({ decision: "publish" }),
      }),
    );
    expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
  });

  it.each(["run", "resume"] as const)(
    "persists an oversized %s checkpoint before limiting output and recovers it without replay",
    async (action) => {
      const prompt = "Review this draft? " + "p".repeat(80 * 1024);
      const { filePath, effectsPath } = await writeWorkflow(
        action === "run" ? { prompt } : { chained: true, chainedPrompt: prompt },
      );
      const taskFlow = await bindFreshRuntime();
      const tool = createTool(taskFlow);
      const firstResult = await tool.execute("start", {
        ...runParams(filePath),
        maxStdoutBytes: 16 * 1024,
        flowStateJson: JSON.stringify({ unrelatedContext: "c".repeat(100 * 1024) }),
      });
      const first = flowResult(firstResult);
      const pausedResult =
        action === "run"
          ? firstResult
          : await tool.execute("first-answer", {
              action: "resume",
              flowId: first.flowId,
              flowExpectedRevision: first.revision,
              responseJson: JSON.stringify({ decision: "publish" }),
              maxStdoutBytes: 16 * 1024,
            });
      const paused = flowResult(pausedResult);
      expect(paused.flow.status).toBe("waiting");
      expect(pausedResult).toMatchObject({ isError: true });
      expect(Buffer.byteLength(JSON.stringify(pausedResult.details, null, 2))).toBeLessThan(
        16 * 1024,
      );
      expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\n");

      await closeStateDatabase?.();
      vi.resetModules();
      const reopened = await bindFreshRuntime();
      const newTool = createTool(reopened);
      const request = { action: "status", flowId: paused.flowId };
      await expect(
        newTool.execute("small-budget", { ...request, maxStdoutBytes: 16 * 1024 }),
      ).rejects.toThrow(/maxStdoutBytes/);
      const status = flowResult(
        await newTool.execute("larger-budget", {
          ...request,
          maxStdoutBytes: 128 * 1024,
        }),
      );
      expect(status.flow).not.toHaveProperty("stateJson");
      expect(requireRecord(status.flow.waitJson, "large input").prompt).toBe(prompt);
      expect(status.revision).toBe(paused.revision);
      const finished = flowResult(
        await newTool.execute("answer", {
          action: "resume",
          flowId: status.flowId,
          flowExpectedRevision: status.revision,
          responseJson: action === "run" ? JSON.stringify({ decision: "publish" }) : "false",
        }),
      );
      expect(finished.flow.status).toBe("succeeded");
      expect(await fs.readFile(effectsPath, "utf8")).toBe("draft\nfinish\n");
    },
  );

  it("paginates all pending inputs without exposing another session's waits", async () => {
    const taskFlow = await bindFreshRuntime();
    const createdAt = Date.now();
    const flows = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        taskFlow.createManaged({
          controllerId: "tests/lobster-input",
          goal: "Pending input",
          status: "waiting",
          createdAt: createdAt + index,
          waitJson: {
            kind: "lobster_input",
            prompt: "Review?",
            responseSchema,
            resumeToken: "pagination-checkpoint",
            cwd: process.cwd(),
          },
        }),
      ),
    );
    const ids = flows.map((flow) => flow.flowId);
    const tool = createTool(taskFlow);
    const first = requireRecord(
      (await tool.execute("first-page", { action: "status" })).details,
      "first pending page",
    );
    expect(first.nextOffset).toBe(20);
    expect(first.flows).toEqual(
      ids.slice(0, 20).map((flowId) => expect.objectContaining({ flowId })),
    );
    const second = requireRecord(
      (
        await tool.execute("second-page", {
          action: "status",
          flowOffset: first.nextOffset,
        })
      ).details,
      "second pending page",
    );
    expect(second.flows).toEqual([expect.objectContaining({ flowId: ids[20] })]);
    expect(second.nextOffset).toBeUndefined();
    const foreignTool = createTool(await bindFreshRuntime("agent:main:other-session"));
    const foreign = requireRecord(
      (await foreignTool.execute("foreign-pending", { action: "status" })).details,
      "foreign pending page",
    );
    expect(foreign.flows).toEqual([]);
    await expect(
      foreignTool.execute("foreign-detail", { action: "status", flowId: ids[0] }),
    ).rejects.toThrow(/not found/i);
  });
});
