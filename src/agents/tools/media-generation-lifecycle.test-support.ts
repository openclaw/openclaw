import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type * as SessionEntryRuntime from "../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { loadWebMedia } from "../../media/web-media.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { findMediaGenerationOperation } from "../media-generation-activity.js";
import { observeMediaGenerationSettlement } from "../media-generation-activity.observer.test-support.js";
import type { AnyAgentTool } from "./common.js";
import type { createImageGenerateTool } from "./image-generate-tool.js";

type MediaKind = "image" | "video" | "music";
type ToolOptions = NonNullable<Parameters<typeof createImageGenerateTool>[0]>;
type TaskMocks = Record<
  "createOperation" | "completeOperation" | "failOperation",
  ReturnType<typeof vi.fn>
>;
type ToolContract = {
  kind: MediaKind;
  createTool: (options: ToolOptions) => AnyAgentTool;
  tasks: TaskMocks;
  requesterOrigin?: DeliveryContext;
};
const agentSessionKey = "agent:main:discord:direct:123";

export function createMediaRequesterReadMock(
  readEntry: () => SessionEntry | undefined = () => ({
    sessionId: "media-requester",
    updatedAt: 1,
  }),
): Pick<
  typeof SessionEntryRuntime,
  "withSessionEntryReadOnlyInWorker" | "readSessionEntryReadOnlyInWorker"
> {
  return {
    readSessionEntryReadOnlyInWorker: async (_scope, assertCurrent) => {
      assertCurrent?.();
      return readEntry();
    },
    withSessionEntryReadOnlyInWorker: async (_scope, assertCurrent, consume) => {
      assertCurrent();
      return consume({ ok: true, value: readEntry() }, { kind: "file", assertCurrent });
    },
  };
}

function mediaConfig(kind: MediaKind, primary: string, timeoutMs?: number): OpenClawConfig {
  return { agents: { defaults: { mediaModels: { [kind]: { primary, timeoutMs } } } } };
}

const imageReference = (value: string) => ({
  kind: "image" as const,
  buffer: Buffer.from(value),
  contentType: "image/png",
});

/** Hold external results while native detached tasks reach terminal publication. */
export async function withHeldMediaGenerationResult(
  generate: MockInstance,
  tasks: TaskMocks,
  run: (complete: (count?: number) => Promise<void>) => Promise<void>,
) {
  const producer = generate.getMockImplementation()!;
  const released = createDeferred();
  generate.mockImplementation(async (...args: unknown[]) => {
    const result: unknown = await producer(...args);
    await released.promise;
    return result;
  });
  const settlement = observeMediaGenerationSettlement(tasks);
  try {
    await run(async (count = 1) => {
      released.resolve();
      expect(await settlement.wait(count)).toEqual(Array(count).fill("succeeded"));
    });
  } finally {
    released.resolve();
    await settlement.wait(tasks.createOperation.mock.calls.length);
  }
}

/** Join the exact cron cleanup tail before this fixture restores module mocks. */
export async function withHeldCronMediaGenerationResult(
  ...args: Parameters<typeof withHeldMediaGenerationResult>
) {
  const cleanup = vi.spyOn(
    await import("../../cron/run-continuation-cleanup.js"),
    "removeCronRunContinuationSessionIfIdle",
  );
  try {
    await withHeldMediaGenerationResult(...args);
  } finally {
    try {
      await Promise.all(cleanup.mock.results.map(({ value }) => value));
    } finally {
      cleanup.mockRestore();
    }
  }
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
  function setup(phase: Parameters<typeof params.setup>[0], options: Partial<ToolOptions> = {}) {
    const { primary, generate } = params.setup(phase);
    tasks.createOperation.mockReturnValue({ taskId: `task-${kind}-${phase}` });
    const controller = new AbortController();
    const abortReason = new Error(`${kind} requester cancelled`);
    const tool = params.createTool({
      config: mediaConfig(kind, primary),
      requesterOrigin: params.requesterOrigin,
      agentSessionKey,
      ...options,
    });
    return {
      controller,
      abortReason,
      generate,
      execute: (request: { prompt: string; images?: string[] } = { prompt: `a ${kind}` }) =>
        tool.execute(`call-${kind}-${phase}`, request, controller.signal),
      async expectNotStarted(pending: ReturnType<typeof tool.execute>) {
        await expect(pending).rejects.toBe(abortReason);
        expect(tasks.createOperation).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
      },
    };
  }

  it.each([
    { mode: "inline", agentSessionKey: undefined },
    { mode: "detached", agentSessionKey },
  ])(
    `does not start $mode ${kind} generation when its caller aborts during preparation`,
    async ({ agentSessionKey: sessionKey }) => {
      const f = setup("preparation", { agentSessionKey: sessionKey });
      const pending = f.execute();
      f.controller.abort(f.abortReason);
      await f.expectNotStarted(pending);
    },
  );

  it(`stops loading later ${kind} references when the caller aborts a pending reference`, async () => {
    const f = setup("reference", { workspaceDir: process.cwd() });
    const reference = createDeferred<Awaited<ReturnType<typeof loadWebMedia>>>();
    const loadMedia = params.loadMedia().mockResolvedValue(imageReference("second-image"));
    loadMedia.mockImplementationOnce(() => reference.promise);
    const pending = f.execute({ prompt: `a ${kind} with references`, images: params.references });
    await vi.waitFor(() => expect(loadMedia).toHaveBeenCalledOnce());
    f.controller.abort(f.abortReason);
    reference.resolve(imageReference("first-image"));

    await f.expectNotStarted(pending);
    expect(loadMedia).toHaveBeenCalledOnce();
    const loadOptions = loadMedia.mock.calls[0]?.[1];
    const signal = typeof loadOptions === "object" ? loadOptions.requestInit?.signal : undefined;
    if (params.referenceSignal === "caller") {
      expect(signal).toBe(f.controller.signal);
    } else {
      expect(signal).toMatchObject({ aborted: true, reason: f.abortReason });
    }
  });

  it(`keeps an accepted detached ${kind} task running after its requester aborts`, async () => {
    const f = setup("accepted");
    await withHeldMediaGenerationResult(f.generate, tasks, async (complete) => {
      const result = await f.execute();
      f.controller.abort(f.abortReason);
      expect(result.details).toMatchObject({ status: "started" });
      expect(tasks.completeOperation).not.toHaveBeenCalled();
      await complete();
      expect(f.generate).toHaveBeenCalledOnce();
      expect(tasks.completeOperation).toHaveBeenCalledOnce();
    });
  });
}

export function defineMediaGenerationDuplicateTests(
  params: ToolContract & {
    setupProviders: () => MockInstance;
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
  it.each(params.cases)("$name", async (testCase) => {
    const generate = params.setupProviders();
    const now = Date.now();
    const taskId = `task-${testCase.defaultModel ? "recent" : "model-only"}-${kind}`;
    tasks.createOperation.mockReturnValue({ taskId });
    const tool = params.createTool({
      config: mediaConfig(kind, testCase.primary, testCase.timeoutMs),
      agentDir: params.agentDir,
      agentSessionKey,
      requesterOrigin: params.requesterOrigin,
    });
    await withHeldMediaGenerationResult(generate, tasks, async (complete) => {
      await tool.execute("call-model-only-start", testCase.request);
      await complete();
      const createdTask = tasks.createOperation.mock.calls[0]?.[0];
      params.listTasks.mockReturnValue([
        {
          taskId,
          runId: createdTask.runId,
          requestKey: findMediaGenerationOperation(String(createdTask.runId))?.requestKey,
          taskKind: `${kind}_generation`,
          sourceId: `${kind}_generate:google`,
          requesterSessionKey: agentSessionKey,
          task: testCase.request.prompt,
          status: "succeeded",
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
        expect(generate).toHaveBeenCalledOnce();
        expect(tasks.createOperation).toHaveBeenCalledTimes(1);
        expect(result.details).toMatchObject({ duplicateGuard: true, active: false });
      }
    });
  });
}
