// PDF runtime-abort coverage keeps prepared-runtime acquisition cancellable and leak-free.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as modelResolution from "../embedded-agent-runner/model.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
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
    registerProviderStreamForModelMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each(
    (["admitted", "direct"] as const).flatMap((source) =>
      (["denied override", "permitted fallback", "retired after extraction"] as const).map(
        (scenario) => ({ source, scenario }),
      ),
    ),
  )("preserves $source requester model policy for $scenario", async ({ source, scenario }) => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        provider: "test-provider",
        api: "openai-completions",
        input: ["text"],
      });
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          entries: { main: {} },
          defaults: {
            model: "test-provider/allowed",
            models: { "test-provider/blocked": { alias: "blocked-alias" } },
            pdfModel: { primary: "test-provider/blocked", fallbacks: ["test-provider/allowed"] },
          },
        },
      };
      let active = true;
      let sourceHolds = 0;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "pdf-reader",
        scopes: ["operator.write"],
        retain: () => {
          sourceHolds += 1;
          return () => {
            sourceHolds -= 1;
          };
        },
        assertCurrent: () => {
          if (!active) {
            throw new Error("requester retired");
          }
        },
        modelPolicy: prepareOperatorModelPolicy({
          cfg,
          policy: { sourceAgent: "main" },
          manifestPlugins: [],
        }),
      });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockImplementation(async () => {
        active = scenario !== "retired after extraction";
        return { text: "Synthetic document text", images: [] };
      });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Allowed PDF answer." }],
      });
      const tool = (await import("./pdf-tool.js")).createPdfTool({ config: cfg, agentDir });
      if (!tool) {
        throw new Error("expected PDF tool");
      }
      const runWithRequester = <T>(run: () => Promise<T>) =>
        source === "direct"
          ? withOperatorToolGatewayAuthority(
              { scopes: ["operator.write"], operatorRunAuthority: authority },
              run,
            )
          : withGatewayToolCallerIdentity(
              { agentId: "main", sessionKey: "agent:main:reader", operatorAuthority: authority },
              run,
            );
      const work = new AsyncWorkScope();
      try {
        const execution = work.track(() =>
          runWithRequester(() =>
            tool.execute("policy", {
              pdf: "/tmp/synthetic.pdf",
              prompt: "Answer using this PDF.",
              ...(scenario === "denied override" ? { model: "blocked-alias" } : {}),
            }),
          ),
        );
        if (scenario === "permitted fallback") {
          await expect(execution).resolves.toMatchObject({
            content: [{ type: "text", text: "Allowed PDF answer." }],
          });
          expect(completeMock).toHaveBeenCalledOnce();
        } else {
          await expect(execution).rejects.toThrow();
          expect(completeMock).not.toHaveBeenCalled();
        }
        if (scenario === "denied override") {
          expect(loadSpy).not.toHaveBeenCalled();
          expect(preparedModelRuntime.acquireAgentRunPreparedModelRuntime).not.toHaveBeenCalled();
        }
      } finally {
        await work.drain();
      }
    });
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
