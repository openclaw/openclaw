import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { VideoGenerationProvider } from "../video-generation/types.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
  type GenerateVideoRuntimeResult,
} from "./runtime.js";

const mocks = vi.hoisted(() => ({
  generateVideo: vi.fn<typeof generateVideo>(),
  listRuntimeVideoGenerationProviders: vi.fn<typeof listRuntimeVideoGenerationProviders>(),
}));

vi.mock("../../extensions/video-generation-core/runtime-api.js", () => ({
  generateVideo: mocks.generateVideo,
  listRuntimeVideoGenerationProviders: mocks.listRuntimeVideoGenerationProviders,
}));

describe("video-generation runtime facade", () => {
  afterEach(() => {
    mocks.generateVideo.mockReset();
    mocks.listRuntimeVideoGenerationProviders.mockReset();
  });

  it("delegates video generation to the shared video-generation runtime", async () => {
    const result: GenerateVideoRuntimeResult = {
      videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4", fileName: "sample.mp4" }],
      provider: "video-plugin",
      model: "vid-v1",
      attempts: [],
    };
    mocks.generateVideo.mockResolvedValue(result);
    const params = {
      cfg: {
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "animate a cat",
      agentDir: "/tmp/agent",
      authStore: { version: 1, profiles: {} },
    };

    await expect(generateVideo(params)).resolves.toBe(result);
    expect(mocks.generateVideo).toHaveBeenCalledWith(params);
  });

  it("delegates provider listing to the shared video-generation runtime", () => {
    const providers: VideoGenerationProvider[] = [
      {
        id: "video-plugin",
        defaultModel: "vid-v1",
        models: ["vid-v1", "vid-v2"],
        capabilities: {
          maxDurationSeconds: 10,
          supportsAudio: true,
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
        }),
      },
    ];
    mocks.listRuntimeVideoGenerationProviders.mockReturnValue(providers);
    const params = { config: {} as OpenClawConfig };

    expect(listRuntimeVideoGenerationProviders(params)).toBe(providers);
    expect(mocks.listRuntimeVideoGenerationProviders).toHaveBeenCalledWith(params);
  });
});
