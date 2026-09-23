// PDF runtime-abort coverage keeps prepared-runtime acquisition cancellable and leak-free.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as modelResolution from "../embedded-agent-runner/model.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import { createPdfToolInfraStub, withTempPdfAgentDir } from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);

describe("PDF tool prepared-runtime cancellation", () => {
  afterEach(() => {
    completeMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each(["runtime acquisition", "model resolution"])(
    "forwards cancellation to %s before provider work starts",
    async (stage) => {
      await withTempPdfAgentDir(async (agentDir) => {
        await stubPdfToolInfra(agentDir, { provider: "openai" });
        const cfg = {
          agents: { defaults: { pdfModel: { primary: "openai/gpt-5.4-mini" } } },
        } as OpenClawConfig;
        const cancelled = new Error("PDF runtime cancelled");
        const started = createDeferredCore<AbortSignal | undefined>();
        const pending = createDeferredCore<never>();
        const waitForCancellation = (abortSignal?: AbortSignal) => {
          started.resolve(abortSignal);
          abortSignal?.addEventListener("abort", () => pending.reject(cancelled), { once: true });
          return pending.promise;
        };
        if (stage === "runtime acquisition") {
          vi.mocked(
            preparedModelRuntime.acquireAgentRunPreparedModelRuntime,
          ).mockImplementationOnce((_input, options) => waitForCancellation(options?.abortSignal));
        } else {
          vi.spyOn(modelResolution, "resolveModelAsync").mockImplementationOnce(
            (_provider, _model, _agentDir, _cfg, options) =>
              waitForCancellation(options?.abortSignal),
          );
        }
        const tool = (await import("./pdf-tool.js")).createPdfTool({ config: cfg, agentDir });
        if (!tool) {
          throw new Error("expected PDF tool");
        }
        const controller = new AbortController();
        const execution = tool.execute(
          "t1",
          { prompt: "summarize", pdf: "/tmp/a.pdf" },
          controller.signal,
        );
        const assertion =
          stage === "runtime acquisition"
            ? expect(execution).rejects.toMatchObject({
                name: "AbortError",
                message: cancelled.message,
                cause: cancelled,
              })
            : expect(execution).rejects.toBe(cancelled);
        try {
          expect(await started.promise).toBe(controller.signal);
          controller.abort(cancelled);
          await assertion;
          expect(completeMock).not.toHaveBeenCalled();
        } finally {
          controller.abort(cancelled);
          pending.reject(cancelled);
          await assertion;
        }
      });
    },
  );

  it("reports cancellation while retaining the runtime until the generic provider settles", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { release } = await stubPdfToolInfra(agentDir, { provider: "openai" });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "extractable text",
        images: [],
      });
      const completion = createDeferredCore<never>();
      completeMock.mockImplementationOnce(() => completion.promise);
      const cfg = {
        agents: { defaults: { pdfModel: { primary: "openai/gpt-5.4-mini" } } },
      } as OpenClawConfig;
      const tool = (await import("./pdf-tool.js")).createPdfTool({ config: cfg, agentDir });
      if (!tool) {
        throw new Error("expected PDF tool");
      }
      const controller = new AbortController();
      const execution = tool.execute(
        "t1",
        { prompt: "summarize", pdf: "/tmp/a.pdf" },
        controller.signal,
      );

      await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
      expect(vi.mocked(pdfExtractModule.extractPdfContent).mock.calls[0]?.[0].signal).toBe(
        controller.signal,
      );
      const options = completeMock.mock.calls[0]?.[2];
      expect(options?.signal).toBe(controller.signal);
      const assertion = expect(execution).rejects.toThrow("PDF provider cancelled");
      controller.abort(new Error("PDF provider cancelled"));
      await assertion;

      expect(release).not.toHaveBeenCalled();
      completion.reject(new Error("late provider failure"));
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    });
  });
});
