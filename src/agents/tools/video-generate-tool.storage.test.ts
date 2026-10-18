import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveVideoGenerationModeCapabilities } from "../../video-generation/capabilities.js";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "../../video-generation/types.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { createVideoGenerateTool } from "./video-generate-tool.js";

function createMp4Fixture(): Buffer {
  return Buffer.from("000000186674797069736f6d0000020069736f6d6d703431", "hex");
}

function createConfig(primary: string, fallbacks: string[]): OpenClawConfig {
  return { agents: { defaults: { mediaModels: { video: { primary, fallbacks } } } } };
}

function createTool(root: string, config: OpenClawConfig, providers: VideoGenerationProvider[]) {
  const tool = createVideoGenerateTool({
    config,
    agentDir: path.join(root, "agent"),
    workspaceDir: root,
    preparedModelRuntime: {
      mediaCapabilityProviders: { videoGenerationProviders: providers },
    } as unknown as PreparedModelRuntimeSnapshot,
  });
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

const isConfigured = () => true;
function provider(
  id: string,
  model: string,
  overrides: Pick<VideoGenerationProvider, "generateVideo"> & Partial<VideoGenerationProvider>,
): VideoGenerationProvider {
  return { id, defaultModel: model, models: [model], isConfigured, capabilities: {}, ...overrides };
}

function video(fileName: string, source: { buffer?: Buffer; url?: string }) {
  return { ...source, fileName, mimeType: "video/mp4" };
}

describe("video generation invocation QA", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("selects image-to-video fallback, forwards declared options, and persists video bytes", async () => {
    const root = tempDirs.make("openclaw-qa-video-invocation-");
    const referenceBytes = createSolidPngBuffer(2, 2, { r: 32, g: 112, b: 224 });
    const referencePath = path.join(root, "reference.png");
    await fs.writeFile(referencePath, referenceBytes);
    const generatedVideo = createMp4Fixture();
    let primaryGenerateCalls = 0;
    let fallbackRequest: VideoGenerationRequest | undefined;
    const declaredOptions = { seed: "number", draft: "boolean" } as const;
    const capabilities: VideoGenerationProvider["capabilities"] = {
      imageToVideo: { enabled: true, maxInputImages: 1, providerOptions: declaredOptions },
    };
    const primaryProvider = provider("qa-limited-video", "limited-v1", {
      capabilities,
      resolveModelCapabilities: async () => ({ imageToVideo: { enabled: false } }),
      generateVideo: async () => {
        primaryGenerateCalls += 1;
        throw new Error("unsupported provider must be skipped before forwarding");
      },
    });
    const fallbackProvider = provider("qa-capable-video", "capable-v1", {
      capabilities,
      generateVideo: async (request) => {
        fallbackRequest = request;
        return {
          model: request.model,
          videos: [video("provider-result.mp4", { buffer: generatedVideo })],
        };
      },
    });
    const config = createConfig("qa-limited-video/limited-v1", ["qa-capable-video/capable-v1"]);
    const providerOptions = { seed: 17, draft: true };

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const tool = createTool(root, config, [primaryProvider, fallbackProvider]);
      const result = await tool.execute("qa-video-invocation", {
        prompt: "Animate the reference image into a short QA clip.",
        image: referencePath,
        imageRoles: ["first_frame"],
        providerOptions,
        filename: "qa-selected-video.mp4",
      });
      const details = requireDetails(result);

      expect(primaryGenerateCalls).toBe(0);
      const selected = { provider: "qa-capable-video", model: "capable-v1" };
      expect(fallbackRequest).toMatchObject({ ...selected, providerOptions });
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
      expect(details).toMatchObject({ ...selected, count: 1 });
      expect(details.attempts).toEqual([
        {
          provider: "qa-limited-video",
          model: "limited-v1",
          error: expect.stringContaining(
            "does not support reference image inputs; skipping to avoid silent reference drop",
          ),
        },
      ]);

      const savedPath = savedVideoPath(details, 0, 1);
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
    const orderedProvider = provider("qa-ordered-video", "ordered-v1", {
      generateVideo: async () => ({
        videos: [
          video("first.mp4", { url: "https://media.example/first.mp4" }),
          video("middle.mp4", { buffer: savedVideo }),
          video("last.mp4", { buffer: oversizedVideo, url: "https://media.example/last.mp4" }),
        ],
      }),
    });
    const config = createConfig("qa-ordered-video/ordered-v1", []);
    config.agents!.defaults!.mediaMaxMb = savedVideo.byteLength / (1024 * 1024);

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const tool = createTool(root, config, [orderedProvider]);
      const result = await tool.execute("qa-video-output-order", {
        prompt: "Generate three ordered QA clips.",
      });
      const details = requireDetails(result);
      const paths = details.paths as string[];

      expect(paths[0]).toBe("https://media.example/first.mp4");
      expect(paths[2]).toBe("https://media.example/last.mp4");
      const savedPath = savedVideoPath(details, 1, 3);
      await expect(fs.readFile(savedPath)).resolves.toEqual(savedVideo);
      expect(details.attachments).toMatchObject([
        { url: paths[0], name: "first.mp4" },
        { path: savedPath, name: "middle.mp4" },
        { url: paths[2], name: "last.mp4" },
      ]);
    });
  });
});

function savedVideoPath(details: Record<string, unknown>, index: number, count: number) {
  const paths = details.paths as string[];
  expect(paths).toHaveLength(count);
  const savedPath = paths[index];
  if (!savedPath) {
    throw new Error("expected saved video path");
  }
  return savedPath;
}
