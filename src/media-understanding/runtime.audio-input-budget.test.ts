// Audio input budget tests keep configuration preparation separate from media execution.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAudioInputBudget } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  buildProviderRegistry: vi.fn(() => new Map()),
  runCapability: vi.fn(),
}));

vi.mock("./runner.js", () => ({
  buildProviderRegistry: mocks.buildProviderRegistry,
  runCapability: mocks.runCapability,
}));

describe("media-understanding audio input budget", () => {
  afterEach(() => {
    mocks.buildProviderRegistry.mockReset();
    mocks.runCapability.mockReset();
  });

  it.each([
    { name: "automatic selection", cfg: {}, maxBytes: 20 * 1024 * 1024 },
    {
      name: "automatic input override",
      cfg: { tools: { media: { audio: { maxBytes: 4096 } } } },
      maxBytes: 4096,
    },
    {
      name: "larger audio fallback but not an image entry",
      cfg: {
        tools: {
          media: {
            audio: { maxBytes: 256 },
            models: [
              { provider: "first", capabilities: ["audio"], maxBytes: 1024 },
              { provider: "second", capabilities: ["audio"], maxBytes: 4096 },
              { provider: "image", capabilities: ["image"], maxBytes: 8192 },
            ],
          },
        },
      },
      maxBytes: 4096,
    },
    {
      name: "explicit local CLI override",
      cfg: {
        tools: {
          media: {
            audio: { maxBytes: 4096 },
            models: [
              { type: "cli", command: "fixture-asr", capabilities: ["audio"], maxBytes: 1024 },
            ],
          },
        },
      },
      maxBytes: 1024,
    },
    {
      name: "local CLI inheriting audio input limit",
      cfg: {
        tools: {
          media: {
            audio: { maxBytes: 4096 },
            models: [{ type: "cli", command: "fixture-asr", capabilities: ["audio"] }],
          },
        },
      },
      maxBytes: 4096,
    },
    {
      name: "inferred provider capability",
      cfg: {
        tools: {
          media: {
            models: [{ provider: "registered-audio", maxBytes: 8192 }],
          },
        },
      },
      maxBytes: 8192,
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; maxBytes: number }>)(
    "prepares the existing transcription input budget for $name",
    async ({ cfg, maxBytes }) => {
      mocks.buildProviderRegistry.mockReturnValue(
        new Map([["registered-audio", { capabilities: ["audio"] }]]),
      );
      await expect(resolveAudioInputBudget({ cfg })).resolves.toEqual({ enabled: true, maxBytes });
      expect(mocks.runCapability).not.toHaveBeenCalled();
    },
  );

  it("does not load providers to prepare disabled audio input", async () => {
    await expect(
      resolveAudioInputBudget({ cfg: { tools: { media: { audio: { enabled: false } } } } }),
    ).resolves.toEqual({ enabled: false });
    expect(mocks.buildProviderRegistry).not.toHaveBeenCalled();
  });
});
