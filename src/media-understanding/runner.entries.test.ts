import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaUnderstandingProvider } from "./types.js";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(async () => ({ mode: "api-key" })),
  requireApiKey: vi.fn(() => {
    throw new Error('No API key found for provider "executorch"');
  }),
}));

import { runProviderEntry } from "./runner.entries.js";

describe("runProviderEntry", () => {
  it("allows keyless local providers to execute without configured API keys", async () => {
    const transcribeAudio = vi.fn(async () => ({ text: "hello from executorch" }));
    const provider: MediaUnderstandingProvider = {
      id: "executorch",
      capabilities: ["audio"],
      requiresApiKey: false,
      transcribeAudio,
    };

    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: {},
        },
      },
    };

    const result = await runProviderEntry({
      capability: "audio",
      entry: { provider: "executorch" },
      cfg,
      ctx: {},
      attachmentIndex: 0,
      cache: {
        getBuffer: async () => ({
          buffer: Buffer.alloc(2048, 1),
          fileName: "sample.wav",
          mime: "audio/wav",
          size: 2048,
        }),
      } as never,
      providerRegistry: new Map([["executorch", provider]]),
    });

    expect(result?.text).toBe("hello from executorch");
    expect(transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "local",
      }),
    );
  });
});
