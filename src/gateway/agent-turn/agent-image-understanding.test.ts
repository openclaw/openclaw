import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import type { MediaExecutionContext } from "../../media-understanding/provider-execution.js";
import type { MediaUnderstandingProvider } from "../../media-understanding/types.js";
// Include the shared runtime in the compiled fixture instead of compiling its lazy import mid-test.
import "../../media-understanding/apply.runtime.js";
import { prepareAgentImageUnderstanding } from "./agent-image-understanding.js";

const describeImage = vi.hoisted(() =>
  vi.fn<NonNullable<MediaUnderstandingProvider["describeImage"]>>(),
);
const resolveImageCompressionModelPolicy = vi.hoisted(() => vi.fn(async () => ({})));

// mock-isolation: Supply only the external vision provider; do not discover live plugins.
vi.mock("../../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: ({ key }: { key: string }) =>
    key === "mediaUnderstandingProviders"
      ? [{ id: "fixture-vision", capabilities: ["image"], describeImage }]
      : [],
}));

// mock-isolation: Model limits are an independent provider contract, with no runtime bootstrap.
vi.mock("../../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy,
}));

// mock-isolation: Keep model discovery outside the fixture's real media-understanding path.
vi.mock("../../agents/prepared-model-catalog.js", () => ({
  readPreparedModelCatalog: async () => [
    { provider: "ollama", id: "qwen3:4b", name: "Qwen", input: ["text"] },
  ],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const imageBytes = createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 });
const activeModel = { provider: "ollama", model: "qwen3:4b" };
const configuredVision: OpenClawConfig = {
  agents: { defaults: { model: { primary: "ollama/qwen3:4b" } } },
  tools: {
    media: {
      models: [
        { provider: "fixture-vision", model: "fixture-image-model", capabilities: ["image"] },
      ],
    },
  },
};
let workspaceDir: string;
let imagePath: string;

function prepare(
  cfg = configuredVision,
  execution?: MediaExecutionContext,
  source: { channel?: string; chatType?: string } = {},
) {
  return prepareAgentImageUnderstanding({
    ...source,
    message: "What color is the square?",
    media: [{ path: imagePath, contentType: "image/png", fileName: "square.png" }],
    cfg,
    agentId: "main",
    agentDir: path.join(workspaceDir, "agent"),
    workspaceDir,
    sessionKey: "agent:main:image-offload",
    activeModel,
    execution,
  });
}

describe("agent image understanding", () => {
  beforeAll(async () => {
    workspaceDir = tempDirs.make("openclaw-agent-image-understanding-");
    imagePath = path.join(workspaceDir, "square.png");
    await fs.writeFile(imagePath, imageBytes);
  });

  beforeEach(() => {
    describeImage.mockReset().mockResolvedValue({ text: "A red square." });
    resolveImageCompressionModelPolicy.mockReset().mockResolvedValue({});
  });

  it("sends pixels to the configured vision provider and gives the text primary its description", async () => {
    const result = await prepare();

    expect(describeImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        buffer: imageBytes,
        mime: "image/png",
        provider: "fixture-vision",
        model: "fixture-image-model",
      }),
    );
    expect(result.message).toBe(
      "[Image]\nUser text:\nWhat color is the square?\nDescription:\nA red square.",
    );
    expect(result.media).toEqual([
      {
        path: imagePath,
        contentType: "image/png",
        fileName: "square.png",
        hydrationSuppressed: true,
      },
    ]);
  });

  it("names the configuration step when no vision provider is configured", async () => {
    await expect(prepare({})).rejects.toThrow(
      "Configure agents.defaults.imageModel or tools.media.models with an available vision model, then retry.",
    );
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("rejects an empty vision response instead of silently discarding the image", async () => {
    describeImage.mockResolvedValue({ text: "   " });

    await expect(prepare()).rejects.toThrow("Image attachments could not be analyzed.");
  });

  it.each([{ channel: "webchat" }, { chatType: "group" as const }])(
    "honors image scope restrictions for %j before sending pixels",
    async (source) => {
      const cfg: OpenClawConfig = {
        ...configuredVision,
        tools: {
          media: {
            ...configuredVision.tools?.media,
            image: { scope: { default: "allow", rules: [{ action: "deny", match: source }] } },
          },
        },
      };

      await expect(prepare(cfg, undefined, source)).rejects.toThrow(
        "Image attachments could not be analyzed.",
      );
      expect(describeImage).not.toHaveBeenCalled();
    },
  );

  it("does not send pixels after request authority is revoked during image preparation", async () => {
    let current = true;
    resolveImageCompressionModelPolicy.mockImplementationOnce(async () => {
      current = false;
      return {};
    });

    await expect(
      prepare(configuredVision, {
        signal: new AbortController().signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Request authority expired");
          }
        },
      }),
    ).rejects.toThrow("Image attachments could not be analyzed.");
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("carries cancellation and live authority into asynchronous image adapters", async () => {
    const controller = new AbortController();
    const sendPixels = vi.fn(async () => new Response("A red square."));
    let current = true;
    let adapterSignal: AbortSignal | undefined;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Request authority expired");
      }
    };
    describeImage.mockImplementationOnce(async (request) => {
      adapterSignal = request.signal;
      await Promise.resolve();
      current = false;
      const result = await fetchWithSsrFGuard({
        url: "https://vision.example/describe",
        fetchImpl: sendPixels,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        init: { method: "POST", body: new Uint8Array(request.buffer), signal: request.signal },
      });
      try {
        return { text: await result.response.text() };
      } finally {
        await result.release();
      }
    });

    await expect(
      prepare(configuredVision, { signal: controller.signal, assertCurrent }),
    ).rejects.toThrow("Image attachments could not be analyzed.");
    expect(adapterSignal).toBe(controller.signal);
    expect(sendPixels).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });
});
