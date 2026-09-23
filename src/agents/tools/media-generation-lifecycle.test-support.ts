import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { loadWebMedia } from "../../media/web-media.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AnyAgentTool } from "./common.js";
import type { createImageGenerateTool } from "./image-generate-tool.js";

type MediaKind = "image" | "video" | "music";
type ToolOptions = NonNullable<Parameters<typeof createImageGenerateTool>[0]>;
type TaskMocks = {
  createRunningTaskRun: ReturnType<typeof vi.fn>;
  completeTaskRunByRunId: ReturnType<typeof vi.fn>;
};
type ToolContract = {
  kind: MediaKind;
  createTool: (options: ToolOptions) => AnyAgentTool;
  tasks: TaskMocks;
  requesterOrigin?: DeliveryContext;
};
const agentSessionKey = "agent:main:discord:direct:123";

function mediaConfig(kind: MediaKind, primary: string, timeoutMs?: number): OpenClawConfig {
  return { agents: { defaults: { mediaModels: { [kind]: { primary, timeoutMs } } } } };
}

function detailsOf(result: Awaited<ReturnType<AnyAgentTool["execute"]>>) {
  expect(result.details).toBeTypeOf("object");
  return result.details as Record<string, unknown>;
}

export function defineMediaGenerationCancellationTests(
  params: ToolContract & {
    setup: (phase: "preparation" | "reference" | "accepted") => {
      primary: string;
      generate: MockInstance;
    };
    loadMedia: () => MockInstance<typeof loadWebMedia>;
    references: string[];
    referenceSignal: "caller" | "composed";
  },
) {
  const { kind, tasks } = params;
  const createTool = (primary: string, options: Omit<ToolOptions, "config">) =>
    params.createTool({
      config: mediaConfig(kind, primary),
      requesterOrigin: params.requesterOrigin,
      ...options,
    });

  it.each([
    { mode: "inline", agentSessionKey: undefined },
    { mode: "detached", agentSessionKey },
  ])(
    `does not start $mode ${kind} generation when its caller aborts during preparation`,
    async ({ agentSessionKey: sessionKey }) => {
      const { primary, generate } = params.setup("preparation");
      tasks.createRunningTaskRun.mockReturnValue({ taskId: `task-${kind}-aborted` });
      const scheduleBackgroundWork = vi.fn();
      const tool = createTool(primary, { agentSessionKey: sessionKey, scheduleBackgroundWork });
      const controller = new AbortController();
      const abortReason = new Error(`${kind} requester cancelled`);

      const pending = tool.execute(
        `call-${kind}-aborted`,
        { prompt: `a ${kind}` },
        controller.signal,
      );
      controller.abort(abortReason);

      await expect(pending).rejects.toBe(abortReason);
      expect(tasks.createRunningTaskRun).not.toHaveBeenCalled();
      expect(scheduleBackgroundWork).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it(`stops loading later ${kind} references when the caller aborts a pending reference`, async () => {
    const { primary, generate } = params.setup("reference");
    const reference = createDeferred<Awaited<ReturnType<typeof loadWebMedia>>>();
    const loadMedia = params.loadMedia().mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("second-image"),
      contentType: "image/png",
    });
    loadMedia.mockImplementationOnce(() => reference.promise);
    tasks.createRunningTaskRun.mockReturnValue({ taskId: `task-${kind}-references` });
    const scheduleBackgroundWork = vi.fn();
    const tool = createTool(primary, {
      workspaceDir: process.cwd(),
      agentSessionKey,
      scheduleBackgroundWork,
    });
    const controller = new AbortController();
    const abortReason = new Error(`${kind} requester cancelled while loading a reference`);
    const pending = tool.execute(
      `call-${kind}-references-aborted`,
      { prompt: `a ${kind} with references`, images: params.references },
      controller.signal,
    );
    await vi.waitFor(() => expect(loadMedia).toHaveBeenCalledOnce());
    controller.abort(abortReason);
    reference.resolve({
      kind: "image",
      buffer: Buffer.from("first-image"),
      contentType: "image/png",
    });

    await expect(pending).rejects.toBe(abortReason);
    expect(loadMedia).toHaveBeenCalledOnce();
    expect(tasks.createRunningTaskRun).not.toHaveBeenCalled();
    expect(scheduleBackgroundWork).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    const loadOptions = loadMedia.mock.calls[0]?.[1];
    const signal = typeof loadOptions === "object" ? loadOptions.requestInit?.signal : undefined;
    if (params.referenceSignal === "caller") {
      expect(signal).toBe(controller.signal);
    } else {
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe(abortReason);
    }
  });

  it(`keeps an accepted detached ${kind} task running after its requester aborts`, async () => {
    const { primary, generate } = params.setup("accepted");
    tasks.createRunningTaskRun.mockReturnValue({ taskId: `task-${kind}-accepted` });
    const controller = new AbortController();
    const scheduled: Array<() => Promise<void>> = [];
    const tool = createTool(primary, {
      agentSessionKey,
      scheduleBackgroundWork: (work) => scheduled.push(work),
      onAsyncTaskStarted: () => controller.abort(new Error("requester ended after acceptance")),
    });
    const result = await tool.execute(
      `call-${kind}-accepted`,
      { prompt: `an accepted ${kind}` },
      controller.signal,
    );

    expect(detailsOf(result).status).toBe("started");
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(generate).toHaveBeenCalledOnce();
    expect(tasks.completeTaskRunByRunId).toHaveBeenCalledOnce();
  });
}

export function defineMediaGenerationDuplicateTests(
  params: ToolContract & {
    setupProviders: () => void;
    listTasks: ReturnType<typeof vi.fn>;
    cases: Array<{
      name: string;
      primary: string;
      model: string;
      defaultModel?: boolean;
      timeoutMs?: number;
      request: { prompt: string; filename?: string; instrumental?: boolean };
      progressSummary: string;
    }>;
    agentDir?: string;
  },
) {
  const { kind, tasks } = params;
  const title = kind.charAt(0).toUpperCase() + kind.slice(1);
  for (const testCase of params.cases) {
    it(testCase.name, async () => {
      params.setupProviders();
      const now = Date.now();
      const taskId = `task-${testCase.defaultModel ? "recent" : "model-only"}-${kind}`;
      tasks.createRunningTaskRun.mockReturnValue({ taskId });
      const scheduled: Array<() => Promise<void>> = [];
      const tool = params.createTool({
        config: mediaConfig(kind, testCase.primary, testCase.timeoutMs),
        agentDir: params.agentDir,
        agentSessionKey,
        requesterOrigin: params.requesterOrigin,
        scheduleBackgroundWork: (work) => scheduled.push(work),
      });
      await tool.execute("call-model-only-start", testCase.request);
      const createdTask = tasks.createRunningTaskRun.mock.calls[0]?.[0];
      expect(createdTask?.runId).toMatch(new RegExp(`^tool:${kind}_generate:`));
      params.listTasks.mockReturnValue([
        {
          taskId,
          runId: createdTask.runId,
          runtime: "cli",
          taskKind: `${kind}_generation`,
          sourceId: `${kind}_generate:google`,
          requesterSessionKey: agentSessionKey,
          ownerKey: agentSessionKey,
          scopeKind: "session",
          task: testCase.request.prompt,
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: now - 20_000,
          endedAt: now - 10_000,
          progressSummary: testCase.progressSummary,
        },
      ]);
      const repeats = testCase.defaultModel
        ? [testCase.primary, testCase.model]
        : [`google/${testCase.model}`];
      for (const [index, model] of repeats.entries()) {
        const result = await tool.execute(`call-repeat-${index}`, {
          ...testCase.request,
          model,
        });
        expect(scheduled).toHaveLength(1);
        expect(tasks.createRunningTaskRun).toHaveBeenCalledTimes(1);
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining(`${title} generation task ${taskId} recently succeeded`),
        });
        expect(detailsOf(result).duplicateGuard).toBe(true);
        expect(detailsOf(result).active).toBe(false);
      }
    });
  }
}
