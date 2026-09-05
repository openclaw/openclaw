// Structured extraction dispatch defaults that do not fit the main runtime
// suite: the agent-dir fallback handed to provider hooks.
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";

const mocks = vi.hoisted(() => ({
  getMediaUnderstandingProvider: vi.fn(),
}));

vi.mock("./provider-registry.js", () => ({
  normalizeMediaProviderId: (provider: string) => provider.trim().toLowerCase(),
  buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
  getMediaUnderstandingProvider: mocks.getMediaUnderstandingProvider,
}));

const { extractStructuredWithModel } = await import("./runtime.js");

describe("extractStructuredWithModel agent directory", () => {
  it("defaults to the configured default agent directory when the caller omits it", async () => {
    // An empty agentDir resolves to process.cwd() downstream, which matches no
    // prepared-model-runtime owner inside a gateway. Callers that omit it, such
    // as Logbook's frame analysis, must land on the configured default instead,
    // the same as direct image description does.
    const extractStructured = vi.fn(async () => ({
      text: "{}",
      parsed: {},
      model: "vision-json",
      provider: "vision-plugin",
      contentType: "json" as const,
    }));
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin", extractStructured });
    const cfg = {} as OpenClawConfig;

    await extractStructuredWithModel({
      input: [
        {
          type: "image",
          buffer: Buffer.from("image-bytes"),
          fileName: "fact.png",
          mime: "image/png",
        },
      ],
      instructions: "Return JSON.",
      provider: "vision-plugin",
      model: "vision-json",
      cfg,
    });

    expect(extractStructured).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: resolveDefaultAgentDir(cfg) }),
    );
  });
});
