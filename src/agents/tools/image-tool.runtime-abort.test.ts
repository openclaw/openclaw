import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as operatorInvocation from "../../gateway/operator-invocation-authority.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import type {
  ImageDescriptionRequest,
  ImagesDescriptionRequest,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createImageTool } from "./image-tool.js";
import {
  createMinimaxImageConfig,
  ONE_PIXEL_PNG_B64,
  resolveConfiguredImageModelForTest,
  testing,
} from "./image-tool.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  return await run(tempDirs.make("openclaw-image-abort-"));
}

function createRequiredImageTool(options: Parameters<typeof createImageTool>[0]) {
  const tool = createImageTool(options);
  if (!tool) {
    throw new Error("expected image tool");
  }
  return tool;
}

type MockImageLoadWebMedia = Awaited<
  ReturnType<
    NonNullable<
      NonNullable<Parameters<typeof testing.setProviderDepsForTest>[0]>["loadImageWebMediaRuntime"]
    >
  >
>["loadWebMedia"];

describe("image tool run abort", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    testing.setProviderDepsForTest();
  });

  function makeDescribeSpies() {
    const describeImage = vi.fn(async (params: ImageDescriptionRequest) => ({
      text: "ok",
      model: params.model,
    }));
    const describeImages = vi.fn(async (params: ImagesDescriptionRequest) => ({
      text: "ok",
      model: params.model,
    }));
    return { describeImage, describeImages };
  }

  function installAbortImageDeps(
    loadWebMedia: MockImageLoadWebMedia,
    spies: ReturnType<typeof makeDescribeSpies>,
    providers: MediaUnderstandingProvider[] = [
      { id: "minimax", capabilities: ["image"] },
      { id: "moonshot", capabilities: ["image"] },
    ],
    resolveModelAsync = resolveConfiguredImageModelForTest,
  ) {
    const providerRegistry = buildMediaUnderstandingRegistry(undefined, undefined, providers);
    testing.setProviderDepsForTest({
      buildProviderRegistry: (overrides, cfg) =>
        buildMediaUnderstandingRegistry(overrides, cfg, providers),
      getMediaUnderstandingProvider,
      resolveRegisteredMediaUnderstandingProvider: ({ providerId }) =>
        getMediaUnderstandingProvider(providerId, providerRegistry),
      resolveModelAsync,
      loadImageWebMediaRuntime: async () => ({
        loadWebMedia,
        optimizeImageBufferForWebMedia: async ({ buffer, contentType, fileName }) => ({
          buffer,
          contentType: contentType ?? "image/png",
          kind: "image",
          fileName,
        }),
      }),
      describeImageWithModel: spies.describeImage,
      describeImagesWithModel: spies.describeImages,
    });
  }

  it.each(
    (["admitted", "direct"] as const).flatMap((source) =>
      (
        [
          "denied override",
          "permitted fallback",
          "retired after download",
          "mutated override",
          "mutated path",
        ] as const
      ).map((scenario) => ({ source, scenario })),
    ),
  )("preserves $source requester model policy for $scenario", async ({ source, scenario }) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        entries: { main: {} },
        defaults: {
          model: "test-provider/allowed",
          models: { "test-provider/blocked": { alias: "blocked-alias" } },
          imageModel: { primary: "test-provider/blocked", fallbacks: ["test-provider/allowed"] },
        },
      },
    };
    let active = true;
    let sourceHolds = 0;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "image-reader",
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
    const loadWebMedia = vi.fn<MockImageLoadWebMedia>(async () => {
      active = scenario !== "retired after download";
      return {
        buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
        contentType: "image/png",
        kind: "image",
      };
    });
    const spies = makeDescribeSpies();
    const resolveModel = vi.fn(resolveConfiguredImageModelForTest);
    installAbortImageDeps(
      loadWebMedia,
      spies,
      [{ id: "test-provider", capabilities: ["image"] }],
      resolveModel,
    );
    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({ config: cfg, agentDir });
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
      const changedDuringCapture = scenario === "mutated override" || scenario === "mutated path";
      const captureStarted = createDeferredCore();
      const resumeCapture = createDeferredCore();
      const capture = operatorInvocation.captureAmbientGatewayOperatorAuthority;
      const captureSpy = changedDuringCapture
        ? vi
            .spyOn(operatorInvocation, "captureAmbientGatewayOperatorAuthority")
            .mockImplementation(async (params) => {
              const retained = await capture(params);
              captureStarted.resolve();
              await resumeCapture.promise;
              return retained;
            })
        : undefined;
      const args = {
        paths: ["https://example.test/image.png"],
        prompt: "Answer using this image.",
        model:
          scenario === "denied override" || scenario === "mutated override"
            ? "blocked-alias"
            : undefined,
      };
      const work = new AsyncWorkScope();
      try {
        const execution = work.track(() => runWithRequester(() => tool.execute("policy", args)));
        if (changedDuringCapture) {
          await Promise.race([captureStarted.promise, execution]);
          args.model = scenario === "mutated override" ? undefined : "blocked-alias";
          args.paths[0] = "https://example.test/replacement.png";
          resumeCapture.resolve();
        }
        if (scenario === "permitted fallback" || scenario === "mutated path") {
          await expect(execution).resolves.toMatchObject({
            content: [{ type: "text", text: "ok" }],
          });
          expect(spies.describeImage).toHaveBeenCalledWith(
            expect.objectContaining({ provider: "test-provider", model: "allowed" }),
          );
        } else {
          await expect(execution).rejects.toThrow();
          expect(spies.describeImage).not.toHaveBeenCalled();
          expect(spies.describeImages).not.toHaveBeenCalled();
        }
        if (scenario === "mutated path") {
          expect(loadWebMedia).toHaveBeenCalledExactlyOnceWith(
            "https://example.test/image.png",
            expect.any(Object),
          );
        }
        if (scenario === "denied override" || scenario === "mutated override") {
          expect(loadWebMedia).not.toHaveBeenCalled();
          expect(resolveModel).not.toHaveBeenCalled();
        }
      } finally {
        resumeCapture.resolve();
        await work.drain();
        captureSpy?.mockRestore();
      }
      expect(sourceHolds).toBe(0);
    });
  });

  it("forwards the run signal through the provider request contract", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const loadWebMedia: MockImageLoadWebMedia = vi.fn(async () => ({
      buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      contentType: "image/png",
      kind: "image" as const,
    }));
    const spies = makeDescribeSpies();
    installAbortImageDeps(loadWebMedia, spies, [{ id: "minimax", capabilities: ["image"] }]);
    const controller = new AbortController();

    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({ config: createMinimaxImageConfig(), agentDir });
      await tool.execute(
        "t1",
        {
          prompt: "Describe the images.",
          paths: ["https://example.test/a.png", "https://example.test/b.png"],
        },
        controller.signal,
      );
    });

    expect(spies.describeImages).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it.each(["before execution", "during model resolution"] as const)(
    "skips downloads and provider calls when aborted %s",
    async (phase) => {
      vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
      const loadWebMedia: MockImageLoadWebMedia = vi.fn(async () => ({
        buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
        contentType: "image/png",
        kind: "image" as const,
      }));
      const spies = makeDescribeSpies();
      const controller = new AbortController();
      const reason = new Error("Image model selection cancelled");
      const modelStarted = createDeferredCore<AbortSignal | undefined>();
      const releaseModel = createDeferredCore();
      const resolveModel = vi.fn(resolveConfiguredImageModelForTest);
      if (phase === "during model resolution") {
        resolveModel.mockImplementation(async (...args) => {
          const abortSignal = args[4]?.abortSignal;
          modelStarted.resolve(abortSignal);
          await racePromiseWithAbortSignal(releaseModel.promise, abortSignal);
          return resolveConfiguredImageModelForTest(...args);
        });
      }
      installAbortImageDeps(loadWebMedia, spies, undefined, resolveModel);

      await withTempAgentDir(async (agentDir) => {
        const tool = createRequiredImageTool({ config: createMinimaxImageConfig(), agentDir });
        if (phase === "before execution") {
          controller.abort(reason);
        }
        const execution = tool.execute(
          "t1",
          {
            prompt: "Describe the images.",
            paths: ["https://example.test/a.png", "https://example.test/b.png"],
          },
          controller.signal,
        );
        const assertion = expect(execution).rejects.toBe(reason);
        try {
          if (phase === "during model resolution") {
            expect(await modelStarted.promise).toBe(controller.signal);
            controller.abort(reason);
          }
          await assertion;
          expect(loadWebMedia).not.toHaveBeenCalled();
          expect(spies.describeImage).not.toHaveBeenCalled();
          expect(spies.describeImages).not.toHaveBeenCalled();
          if (phase === "during model resolution") {
            expect(resolveModel).toHaveBeenCalledOnce();
          }
        } finally {
          releaseModel.resolve();
          await Promise.allSettled([execution, assertion]);
        }
      });
    },
  );

  it("stops remaining downloads and skips the provider call when aborted mid-run", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const controller = new AbortController();
    let markDownloadStarted: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    const loadWebMedia: MockImageLoadWebMedia = vi.fn(async (_url, options) => {
      const downloadSignal = options?.requestInit?.signal;
      expect(downloadSignal).toBe(controller.signal);
      markDownloadStarted?.();
      return await new Promise<never>((_, reject) => {
        downloadSignal?.addEventListener(
          "abort",
          () => reject(new Error("aborted", { cause: downloadSignal.reason })),
          { once: true },
        );
      });
    });
    const spies = makeDescribeSpies();
    installAbortImageDeps(loadWebMedia, spies);

    await withTempAgentDir(async (agentDir) => {
      const tool = createRequiredImageTool({ config: createMinimaxImageConfig(), agentDir });

      const execution = tool.execute(
        "t1",
        {
          prompt: "Describe the images.",
          paths: [
            "https://example.test/a.png",
            "https://example.test/b.png",
            "https://example.test/c.png",
          ],
        },
        controller.signal,
      );
      await downloadStarted;
      controller.abort();

      await expect(execution).rejects.toThrow();

      // Only the first image is fetched; the loop exits before the rest and the
      // paid vision provider is never called for the dead run.
      expect(loadWebMedia).toHaveBeenCalledTimes(1);
      expect(spies.describeImage).not.toHaveBeenCalled();
      expect(spies.describeImages).not.toHaveBeenCalled();
    });
  });
});
