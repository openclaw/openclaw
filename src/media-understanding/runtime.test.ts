import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const hoisted = vi.hoisted(() => ({
  describeImageFile: vi.fn(),
  runMediaUnderstandingFile: vi.fn(),
}));

vi.mock("../plugin-sdk/media-understanding-runtime.js", () => ({
  describeImageFile: hoisted.describeImageFile,
  describeImageFileWithModel: vi.fn(),
  describeVideoFile: vi.fn(),
  runMediaUnderstandingFile: hoisted.runMediaUnderstandingFile,
  transcribeAudioFile: vi.fn(),
}));

let describeImageFile: typeof import("./runtime.js").describeImageFile;
let runMediaUnderstandingFile: typeof import("./runtime.js").runMediaUnderstandingFile;

describe("media-understanding runtime facade", () => {
  beforeAll(async () => {
    ({ describeImageFile, runMediaUnderstandingFile } = await import("./runtime.js"));
  });

  afterEach(() => {
    hoisted.describeImageFile.mockReset();
    hoisted.runMediaUnderstandingFile.mockReset();
  });

  it("delegates describeImageFile to the plugin-sdk runtime", async () => {
    const params = {
      filePath: "/tmp/sample.jpg",
      mime: "image/jpeg",
      cfg: {
        tools: {
          media: {
            image: {
              models: [{ provider: "vision-plugin", model: "vision-v1" }],
            },
          },
        },
      } as OpenClawConfig,
      agentDir: "/tmp/agent",
    };
    const result = {
      text: "image ok",
      provider: "vision-plugin",
      model: "vision-v1",
      output: {
        kind: "image.description" as const,
        attachmentIndex: 0,
        text: "image ok",
        provider: "vision-plugin",
        model: "vision-v1",
      },
    };
    hoisted.describeImageFile.mockResolvedValue(result);

    await expect(describeImageFile(params)).resolves.toEqual(result);
    expect(hoisted.describeImageFile).toHaveBeenCalledWith(params);
  });

  it("delegates runMediaUnderstandingFile to the plugin-sdk runtime", async () => {
    const params = {
      capability: "image" as const,
      filePath: "/tmp/sample.jpg",
      mime: "image/jpeg",
      cfg: {
        tools: {
          media: {
            image: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
      agentDir: "/tmp/agent",
    };
    const result = {
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
    };
    hoisted.runMediaUnderstandingFile.mockResolvedValue(result);

    await expect(runMediaUnderstandingFile(params)).resolves.toEqual(result);
    expect(hoisted.runMediaUnderstandingFile).toHaveBeenCalledWith(params);
  });
});
