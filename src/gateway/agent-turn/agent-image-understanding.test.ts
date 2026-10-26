import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
  expect(result).toEqual({
    message: "[Image]\nUser text:\nWhat color is the square?\nDescription:\nA red square.",
    media: [
      {
        path: imagePath,
        contentType: "image/png",
        fileName: "square.png",
        hydrationSuppressed: true,
      },
    ],
  });
});

it.each([
  ["missing provider", undefined],
  ["empty response", undefined],
  ["channel scope denial", { channel: "webchat" }],
  ["group scope denial", { chatType: "group" }],
] as const)("rejects image input for %s", async (failure, source) => {
  if (failure === "empty response") {
    describeImage.mockResolvedValue({ text: "   " });
  }
  const cfg: OpenClawConfig =
    failure === "missing provider"
      ? {}
      : source
        ? {
            ...configuredVision,
            tools: {
              media: {
                ...configuredVision.tools?.media,
                image: { scope: { default: "allow", rules: [{ action: "deny", match: source }] } },
              },
            },
          }
        : configuredVision;
  await expect(prepare(cfg, undefined, source)).rejects.toThrow(
    failure === "missing provider"
      ? "Configure agents.defaults.imageModel or tools.media.models with an available vision model, then retry."
      : "Image attachments could not be analyzed.",
  );
  expect(describeImage).toHaveBeenCalledTimes(failure === "empty response" ? 1 : 0);
});

it.each(["preparation", "adapter"] as const)(
  "rejects revoked authority during %s",
  async (phase) => {
    const controller = new AbortController();
    let current = true;
    const execution: MediaExecutionContext = {
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Request authority expired");
        }
      },
    };
    const sendPixels = vi.fn(async () => new Response("A red square."));
    let adapterSignal: AbortSignal | undefined;
    if (phase === "preparation") {
      resolveImageCompressionModelPolicy.mockImplementationOnce(async () => {
        current = false;
        return {};
      });
    } else {
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
    }

    await expect(prepare(configuredVision, execution)).rejects.toThrow(
      "Image attachments could not be analyzed.",
    );
    expect(describeImage).toHaveBeenCalledTimes(phase === "adapter" ? 1 : 0);
    expect(sendPixels).not.toHaveBeenCalled();
    if (phase === "adapter") {
      expect(adapterSignal).toBe(controller.signal);
    }
    expect(controller.signal.aborted).toBe(false);
  },
);
