import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { describeImageFile, runMediaUnderstandingFile } from "./runtime.js";

describe("media-understanding runtime helpers", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("describes images through the active media-understanding registry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-runtime-"));
    const imagePath = path.join(tempDir, "sample.jpg");
    await fs.writeFile(imagePath, Buffer.from("image-bytes"));

    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "vision-plugin",
      pluginName: "Vision Plugin",
      source: "test",
      provider: {
        id: "vision-plugin",
        capabilities: ["image"],
        describeImage: async () => ({ text: "image ok", model: "vision-v1" }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const cfg = {
      tools: {
        media: {
          image: {
            models: [{ provider: "vision-plugin", model: "vision-v1" }],
          },
        },
      },
    } as OpenClawConfig;

    const result = await describeImageFile({
      filePath: imagePath,
      mime: "image/jpeg",
      cfg,
      agentDir: "/tmp/agent",
    });

    expect(result).toEqual({
      text: "image ok",
      provider: "vision-plugin",
      model: "vision-v1",
      output: {
        kind: "image.description",
        attachmentIndex: 0,
        text: "image ok",
        provider: "vision-plugin",
        model: "vision-v1",
      },
    });
  });

  it("returns undefined when no media output is produced", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-runtime-"));
    const imagePath = path.join(tempDir, "sample.jpg");
    await fs.writeFile(imagePath, Buffer.from("image-bytes"));

    const result = await runMediaUnderstandingFile({
      capability: "image",
      filePath: imagePath,
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
    });

    expect(result).toEqual({
      text: undefined,
      provider: undefined,
      model: undefined,
      output: undefined,
    });
  });
});
