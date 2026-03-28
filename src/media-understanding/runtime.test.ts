import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "../plugins/bundled-compat.js";
import { __testing as loaderTesting } from "../plugins/loader.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";

let describeImageFile: typeof import("./runtime.js").describeImageFile;
let runMediaUnderstandingFile: typeof import("./runtime.js").runMediaUnderstandingFile;
let resolveRuntimePluginRegistryMock: ReturnType<
  typeof vi.fn<(params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined>
>;

function setCompatibleActiveMediaUnderstandingRegistry(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  cfg: OpenClawConfig,
) {
  const pluginIds = loadPluginManifestRegistry({
    config: cfg,
    env: process.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const compatibleConfig = withBundledPluginVitestCompat({
    config: withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: cfg,
        pluginIds,
      }),
      pluginIds,
    }),
    pluginIds,
    env: process.env,
  });
  const { cacheKey } = loaderTesting.resolvePluginLoadCacheContext({
    config: compatibleConfig,
    env: process.env,
  });
  setActivePluginRegistry(pluginRegistry, cacheKey);
}

describe("media-understanding runtime helpers", () => {
  afterEach(() => {
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);
    vi.doUnmock("../plugins/loader.js");
  });

  beforeEach(async () => {
    vi.resetModules();
    resolveRuntimePluginRegistryMock = vi.fn<
      (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
    >(() => undefined);
    vi.doMock("../plugins/loader.js", () => ({
      resolveRuntimePluginRegistry: resolveRuntimePluginRegistryMock,
    }));
    ({ describeImageFile, runMediaUnderstandingFile } = await import("./runtime.js"));
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
    resolveRuntimePluginRegistryMock.mockReturnValue(pluginRegistry);

    const cfg = {
      tools: {
        media: {
          image: {
            models: [{ provider: "vision-plugin", model: "vision-v1" }],
          },
        },
      },
    } as OpenClawConfig;
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);

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
