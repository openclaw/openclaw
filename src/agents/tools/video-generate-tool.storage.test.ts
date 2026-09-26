import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { listFreshTasksForOwnerKey } from "../../tasks/runtime-internal.js";
import { withTaskRegistryTempDir } from "../../tasks/task-registry.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveVideoGenerationModeCapabilities } from "../../video-generation/capabilities.js";
import * as videoGenerationRuntime from "../../video-generation/runtime.js";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "../../video-generation/types.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { videoGenerationTaskLifecycle } from "./media-generate-background.js";
import { createVideoGenerateTool } from "./video-generate-tool.js";

function createMp4Fixture(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
}

function createPreparedRuntime(providers: VideoGenerationProvider[]): PreparedModelRuntimeSnapshot {
  return {
    mediaCapabilityProviders: {
      videoGenerationProviders: providers,
    },
  } as unknown as PreparedModelRuntimeSnapshot;
}

function createConfig(primary: string, fallbacks: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        mediaModels: {
          video: { primary, fallbacks },
        },
      },
    },
  };
}

function requireVideoTool(tool: ReturnType<typeof createVideoGenerateTool>) {
  if (!tool) {
    throw new Error("expected video_generate tool");
  }
  return tool;
}

function requireDetails(result: { details?: unknown }): Record<string, unknown> {
  if (!result.details || typeof result.details !== "object") {
    throw new Error("expected video generation result details");
  }
  return result.details as Record<string, unknown>;
}

describe("video generation invocation QA", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("distinguishes the initial provider from the provider that succeeds after failover", async () => {
    await withTaskRegistryTempDir(async (root) => {
      const sessionKey = "agent:main:media-attribution";
      const fallbackStarted = createDeferredCore();
      const finishGeneration = createDeferredCore();
      const deliveryStarted = createDeferredCore();
      const finishDelivery = createDeferredCore();
      const attempts: string[] = [];
      const providers: VideoGenerationProvider[] = [
        {
          id: "qa-a-primary",
          defaultModel: "primary-v1",
          isConfigured: () => true,
          capabilities: {},
          generateVideo: async () => {
            attempts.push("qa-a-primary");
            throw new Error("primary endpoint unavailable");
          },
        },
        {
          id: "qa-b-fallback",
          defaultModel: "fallback-v1",
          isConfigured: () => true,
          capabilities: {},
          generateVideo: async () => {
            attempts.push("qa-b-fallback");
            fallbackStarted.resolve();
            await finishGeneration.promise;
            return {
              model: "fallback-v1",
              videos: [{ url: "https://media.example/fallback.mp4", mimeType: "video/mp4" }],
            };
          },
        },
      ];
      const wake = vi
        .spyOn(videoGenerationTaskLifecycle, "wakeTaskCompletion")
        .mockImplementation(async () => {
          deliveryStarted.resolve();
          await finishDelivery.promise;
          return { status: "delivered" };
        });
      const providerRegistry = vi
        .spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders")
        .mockReturnValue(providers);
      let scheduledWork: (() => Promise<void>) | undefined;
      const tool = requireVideoTool(
        createVideoGenerateTool({
          config: {},
          agentDir: path.join(root, "agent"),
          workspaceDir: root,
          agentSessionKey: sessionKey,
          requesterAgentId: "main",
          preparedModelRuntime: createPreparedRuntime(providers),
          scheduleBackgroundWork: (work) => {
            scheduledWork = work;
          },
        }),
      );
      let work: Promise<void> | undefined;
      try {
        await tool.execute("qa-video-failover", { prompt: "Generate a failover QA clip." });
        if (!scheduledWork) {
          throw new Error("expected scheduled video generation work");
        }
        work = scheduledWork();
        await fallbackStarted.promise;
        const running = await tool.execute("qa-video-status", { action: "status" });
        finishGeneration.resolve();
        await deliveryStarted.promise;
        const delivering = await tool.execute("qa-video-delivery-status", { action: "status" });
        finishDelivery.resolve();
        await work;
        const [task] = await listFreshTasksForOwnerKey(sessionKey);
        const duplicate = await tool.execute("qa-video-duplicate", {
          prompt: "Generate a failover QA clip.",
        });

        expect(requireDetails(running)).toMatchObject({ selectedProvider: "qa-a-primary" });
        expect(requireDetails(running).provider).toBeUndefined();
        expect(running.content).toEqual([
          expect.objectContaining({
            text: expect.stringContaining("initial provider: qa-a-primary"),
          }),
        ]);
        expect(requireDetails(delivering)).toMatchObject({
          selectedProvider: "qa-a-primary",
          provider: "qa-b-fallback",
          model: "fallback-v1",
        });
        expect(task).toMatchObject({
          sourceId: "video_generate:qa-a-primary",
          status: "succeeded",
          detail: { mediaGeneration: { provider: "qa-b-fallback", model: "fallback-v1" } },
          terminalSummary: "Generated 1 video with qa-b-fallback/fallback-v1.",
        });
        expect(wake.mock.calls[0]?.[0].result).toContain(
          "Generated 1 video with qa-b-fallback/fallback-v1.",
        );
        expect(requireDetails(duplicate)).toMatchObject({
          provider: "qa-b-fallback",
          selectedProvider: "qa-a-primary",
          active: false,
        });
        expect(duplicate.content).toEqual([
          expect.objectContaining({
            text: expect.stringContaining("recently succeeded with qa-b-fallback"),
          }),
        ]);
        expect(attempts).toEqual(["qa-a-primary", "qa-b-fallback"]);
      } finally {
        finishGeneration.resolve();
        finishDelivery.resolve();
        await work;
        wake.mockRestore();
        providerRegistry.mockRestore();
      }
    });
  });

  it("selects image-to-video fallback, forwards declared options, and persists video bytes", async () => {
    const root = tempDirs.make("openclaw-qa-video-invocation-");
    const referenceBytes = createSolidPngBuffer(2, 2, { r: 32, g: 112, b: 224 });
    const referencePath = path.join(root, "reference.png");
    await fs.writeFile(referencePath, referenceBytes);

    const generatedVideo = createMp4Fixture();
    let primaryGenerateCalls = 0;
    let fallbackRequest: VideoGenerationRequest | undefined;
    const primaryProvider: VideoGenerationProvider = {
      id: "qa-limited-video",
      defaultModel: "limited-v1",
      models: ["limited-v1"],
      isConfigured: () => true,
      capabilities: {
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          providerOptions: { seed: "number", draft: "boolean" },
        },
      },
      resolveModelCapabilities: async () => ({
        imageToVideo: {
          enabled: false,
        },
      }),
      generateVideo: async () => {
        primaryGenerateCalls += 1;
        throw new Error("unsupported provider must be skipped before forwarding");
      },
    };
    const fallbackProvider: VideoGenerationProvider = {
      id: "qa-capable-video",
      defaultModel: "capable-v1",
      models: ["capable-v1"],
      isConfigured: () => true,
      capabilities: {
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          providerOptions: { seed: "number", draft: "boolean" },
        },
      },
      generateVideo: async (request) => {
        fallbackRequest = request;
        return {
          model: request.model,
          videos: [
            {
              buffer: generatedVideo,
              mimeType: "video/mp4",
              fileName: "provider-result.mp4",
            },
          ],
        };
      },
    };
    const providers = [primaryProvider, fallbackProvider];
    const config = createConfig("qa-limited-video/limited-v1", ["qa-capable-video/capable-v1"]);
    const providerOptions = { seed: 17, draft: true };

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const tool = requireVideoTool(
        createVideoGenerateTool({
          config,
          agentDir: path.join(root, "agent"),
          workspaceDir: root,
          preparedModelRuntime: createPreparedRuntime(providers),
        }),
      );
      const result = await tool.execute("qa-video-invocation", {
        prompt: "Animate the reference image into a short QA clip.",
        image: referencePath,
        imageRoles: ["first_frame"],
        providerOptions,
        filename: "qa-selected-video.mp4",
      });
      const details = requireDetails(result);

      expect(primaryGenerateCalls).toBe(0);
      expect(fallbackRequest).toMatchObject({
        provider: "qa-capable-video",
        model: "capable-v1",
        providerOptions,
      });
      expect(
        resolveVideoGenerationModeCapabilities({
          provider: fallbackProvider,
          model: fallbackRequest?.model,
          inputImageCount: fallbackRequest?.inputImages?.length,
          inputVideoCount: fallbackRequest?.inputVideos?.length,
        }).mode,
      ).toBe("imageToVideo");
      expect(fallbackRequest?.inputImages).toEqual([
        {
          buffer: referenceBytes,
          mimeType: "image/png",
          fileName: "reference.png",
          role: "first_frame",
        },
      ]);
      expect(details.provider).toBe("qa-capable-video");
      expect(details.model).toBe("capable-v1");
      expect(details.count).toBe(1);
      expect(details.attempts).toEqual([
        {
          provider: "qa-limited-video",
          model: "limited-v1",
          error: expect.stringContaining(
            "does not support reference image inputs; skipping to avoid silent reference drop",
          ),
        },
      ]);

      const savedPaths = details.paths as string[];
      expect(savedPaths).toHaveLength(1);
      const savedPath = savedPaths[0];
      if (!savedPath) {
        throw new Error("expected saved video path");
      }
      const savedStat = await fs.stat(savedPath);
      expect(savedStat.isFile()).toBe(true);
      expect(savedStat.size).toBe(generatedVideo.byteLength);
      await expect(fs.readFile(savedPath)).resolves.toEqual(generatedVideo);
      expect(details.attachments).toEqual([
        expect.objectContaining({
          type: "video",
          path: savedPath,
          name: "qa-selected-video.mp4",
          mimeType: "video/mp4",
          sizeBytes: generatedVideo.byteLength,
        }),
      ]);
    });
  });

  it("preserves provider order through managed storage and URL fallback", async () => {
    const root = tempDirs.make("openclaw-qa-video-output-order-");
    const savedVideo = createMp4Fixture();
    const oversizedVideo = Buffer.concat([savedVideo, Buffer.from([0x00])]);
    const provider: VideoGenerationProvider = {
      id: "qa-ordered-video",
      defaultModel: "ordered-v1",
      models: ["ordered-v1"],
      isConfigured: () => true,
      capabilities: {},
      generateVideo: async () => ({
        videos: [
          {
            url: "https://media.example/first.mp4",
            mimeType: "video/mp4",
            fileName: "first.mp4",
          },
          {
            buffer: savedVideo,
            mimeType: "video/mp4",
            fileName: "middle.mp4",
          },
          {
            buffer: oversizedVideo,
            url: "https://media.example/last.mp4",
            mimeType: "video/mp4",
            fileName: "last.mp4",
          },
        ],
      }),
    };
    const config = createConfig("qa-ordered-video/ordered-v1", []);
    config.agents!.defaults!.mediaMaxMb = savedVideo.byteLength / (1024 * 1024);

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const tool = requireVideoTool(
        createVideoGenerateTool({
          config,
          agentDir: path.join(root, "agent"),
          workspaceDir: root,
          preparedModelRuntime: createPreparedRuntime([provider]),
        }),
      );
      const result = await tool.execute("qa-video-output-order", {
        prompt: "Generate three ordered QA clips.",
      });
      const details = requireDetails(result);
      const paths = details.paths as string[];

      expect(paths).toHaveLength(3);
      expect(paths[0]).toBe("https://media.example/first.mp4");
      expect(paths[2]).toBe("https://media.example/last.mp4");
      const savedPath = paths[1];
      if (!savedPath) {
        throw new Error("expected managed middle video path");
      }
      await expect(fs.readFile(savedPath)).resolves.toEqual(savedVideo);
      expect(details.attachments).toMatchObject([
        { url: paths[0], name: "first.mp4" },
        { path: savedPath, name: "middle.mp4" },
        { url: paths[2], name: "last.mp4" },
      ]);
    });
  });

  it("reports the fractional save cap when a generated video has no provider URL", async () => {
    const root = tempDirs.make("openclaw-qa-video-fractional-cap-");
    const maxBytes = createMp4Fixture().byteLength;
    const provider: VideoGenerationProvider = {
      id: "qa-capped-video",
      defaultModel: "capped-v1",
      models: ["capped-v1"],
      isConfigured: () => true,
      capabilities: {},
      generateVideo: async () => ({
        videos: [
          {
            buffer: Buffer.concat([createMp4Fixture(), Buffer.from([0x00])]),
            mimeType: "video/mp4",
          },
        ],
      }),
    };
    const config = createConfig("qa-capped-video/capped-v1", []);
    config.agents!.defaults!.mediaMaxMb = maxBytes / (1024 * 1024);

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const tool = requireVideoTool(
        createVideoGenerateTool({
          config,
          agentDir: path.join(root, "agent"),
          workspaceDir: root,
          preparedModelRuntime: createPreparedRuntime([provider]),
        }),
      );
      await expect(
        tool.execute("qa-video-fractional-cap", { prompt: "Generate a capped QA clip." }),
      ).rejects.toThrow("Media exceeds 24B limit");
    });
  });

  it("rejects unknown and wrong-typed provider options before provider invocation", async () => {
    let providerCalls = 0;
    const createProvider = (id: string, model: string): VideoGenerationProvider => ({
      id,
      defaultModel: model,
      models: [model],
      isConfigured: () => true,
      capabilities: {
        providerOptions: { seed: "number", draft: "boolean" },
      },
      generateVideo: async () => {
        providerCalls += 1;
        return {
          videos: [{ buffer: createMp4Fixture(), mimeType: "video/mp4" }],
        };
      },
    });
    const providers = [
      createProvider("qa-options-primary", "primary-v1"),
      createProvider("qa-options-fallback", "fallback-v1"),
    ];
    const tool = requireVideoTool(
      createVideoGenerateTool({
        config: createConfig("qa-options-primary/primary-v1", ["qa-options-fallback/fallback-v1"]),
        preparedModelRuntime: createPreparedRuntime(providers),
      }),
    );

    await expect(
      tool.execute("qa-video-options-unknown", {
        prompt: "Generate a QA clip.",
        providerOptions: { seed: 21, unknown_option: true },
      }),
    ).rejects.toThrow(/does not accept providerOptions keys: unknown_option/);
    await expect(
      tool.execute("qa-video-options-type", {
        prompt: "Generate another QA clip.",
        providerOptions: { seed: "twenty-one" },
      }),
    ).rejects.toThrow(/expects providerOptions\.seed to be a finite number, got string/);
    expect(providerCalls).toBe(0);
  });
});
