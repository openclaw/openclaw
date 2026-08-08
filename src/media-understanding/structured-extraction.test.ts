// Covers the shared model-backed structured-extraction path used by every
// image-capable provider without a bespoke implementation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  describeImagesWithModel: vi.fn(),
}));

vi.mock("./image-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./image-runtime.js")>()),
  describeImagesWithModel: mocks.describeImagesWithModel,
}));

import { describeImagesWithModel } from "./image-runtime.js";
import { createStructuredExtractionWithImageModel } from "./structured-extraction.js";

// The hoisted mock above makes this import the mocked describeImagesWithModel,
// so binding once at module scope stays valid across mockReset (same fn object).
const extractStructuredWithImageModel =
  createStructuredExtractionWithImageModel(describeImagesWithModel);

function baseImageInput() {
  return {
    type: "image" as const,
    buffer: Buffer.from("image-bytes"),
    fileName: "image.png",
    mime: "image/png",
  };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    input: [baseImageInput()],
    instructions: "Return summary JSON.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    timeoutMs: 30_000,
    cfg: {},
    agentDir: "/tmp/openclaw-agent",
    ...overrides,
  } as Parameters<typeof extractStructuredWithImageModel>[0];
}

beforeEach(() => {
  mocks.describeImagesWithModel.mockReset();
});

describe("extractStructuredWithImageModel", () => {
  it("routes structured extraction through describeImagesWithModel and parses JSON", async () => {
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: '{"summary":"ok"}',
      model: "claude-sonnet-5",
    });

    const result = await extractStructuredWithImageModel(
      baseRequest({
        input: [{ type: "text", text: "Extract searchable evidence." }, baseImageInput()],
      }),
    );

    expect(mocks.describeImagesWithModel).toHaveBeenCalledTimes(1);
    const call = mocks.describeImagesWithModel.mock.calls[0]?.[0];
    expect(call.model).toBe("claude-sonnet-5");
    expect(call.provider).toBe("anthropic");
    expect(call.images).toEqual([
      { buffer: Buffer.from("image-bytes"), fileName: "image.png", mime: "image/png" },
    ]);
    expect(call.prompt).toContain("Return summary JSON.");
    expect(call.prompt).toContain("Extract searchable evidence.");
    expect(call.prompt).toContain("Return valid JSON only");

    expect(result).toEqual({
      text: '{"summary":"ok"}',
      model: "claude-sonnet-5",
      provider: "anthropic",
      contentType: "json",
      parsed: { summary: "ok" },
    });
  });

  // The bundled Codex extractor sets this boundary in its own developer
  // instructions. This path is reachable from Logbook, whose inputs are full
  // screen captures and whose output is persisted, so the generic fallback must
  // not be the weaker of the two. Asserted on the prompt actually handed to the
  // model, not on the constant.
  it("instructs the model to withhold secrets, in the request it actually sends", async () => {
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: '{"summary":"ok"}',
      model: "claude-sonnet-5",
    });

    await extractStructuredWithImageModel(baseRequest());

    const call = mocks.describeImagesWithModel.mock.calls[0]?.[0];
    expect(call.prompt).toContain("Do not include secrets");
    expect(call.prompt).toContain("passwords, API keys, tokens, or credentials");
  });

  it("keeps the no-secrets instruction in text-mode extraction", async () => {
    // jsonMode:false takes a different tail branch in the prompt builder; the
    // boundary must not depend on which one runs.
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: "a summary",
      model: "claude-sonnet-5",
    });

    await extractStructuredWithImageModel(baseRequest({ jsonMode: false }));

    const call = mocks.describeImagesWithModel.mock.calls[0]?.[0];
    expect(call.prompt).toContain("Do not include secrets");
  });

  it("carries the caller's provider through to the model call", async () => {
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: '{"summary":"ok"}',
      model: "gpt-5.6",
    });

    const result = await extractStructuredWithImageModel(
      baseRequest({ provider: "openai", model: "gpt-5.6" }),
    );

    expect(mocks.describeImagesWithModel.mock.calls[0]?.[0].provider).toBe("openai");
    expect(result?.provider).toBe("openai");
  });

  it("returns text content without parsing when jsonMode is false", async () => {
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: "a plain description",
      model: "claude-sonnet-5",
    });

    const result = await extractStructuredWithImageModel(
      baseRequest({ instructions: "Describe the image.", jsonMode: false }),
    );

    const call = mocks.describeImagesWithModel.mock.calls[0]?.[0];
    expect(call.prompt).toContain("Return the extraction as concise text.");
    expect(result).toEqual({
      text: "a plain description",
      model: "claude-sonnet-5",
      provider: "anthropic",
      contentType: "text",
    });
  });

  it("rejects text-only structured extraction before calling the model", async () => {
    await expect(
      extractStructuredWithImageModel(
        baseRequest({ input: [{ type: "text", text: "The answer is only text." }] }),
      ),
    ).rejects.toThrow("Structured extraction requires at least one image input.");
    expect(mocks.describeImagesWithModel).not.toHaveBeenCalled();
  });

  it("rejects a missing model id before calling the model", async () => {
    await expect(extractStructuredWithImageModel(baseRequest({ model: "  " }))).rejects.toThrow(
      "Structured extraction requires model id.",
    );
    expect(mocks.describeImagesWithModel).not.toHaveBeenCalled();
  });

  it("rejects missing instructions before calling the model", async () => {
    await expect(
      extractStructuredWithImageModel(baseRequest({ instructions: "   " })),
    ).rejects.toThrow("Structured extraction requires instructions.");
    expect(mocks.describeImagesWithModel).not.toHaveBeenCalled();
  });

  it("returns a controlled error when structured JSON parsing fails", async () => {
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: "not json",
      model: "claude-sonnet-5",
    });

    await expect(extractStructuredWithImageModel(baseRequest())).rejects.toThrow(
      "Structured extraction returned invalid JSON",
    );
  });

  it("validates structured extraction JSON against the requested schema", async () => {
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: '{"summary":123,"tags":["shape"]}',
      model: "claude-sonnet-5",
    });

    await expect(
      extractStructuredWithImageModel(
        baseRequest({
          jsonSchema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
          },
        }),
      ),
    ).rejects.toThrow("Structured extraction JSON did not match schema");
  });

  // A MiniMax-VL-01 route answers a multi-image request with one call per image
  // and joins the replies as `Image N:` text, which can never be one JSON
  // document. Logbook samples up to 16 frames per call, so this is its real
  // shape on that provider.
  it("refuses multi-image structured extraction on a split-response route", async () => {
    await expect(
      extractStructuredWithImageModel(
        baseRequest({
          provider: "minimax",
          model: "MiniMax-VL-01",
          input: [baseImageInput(), baseImageInput()],
        }),
      ),
    ).rejects.toThrow("Provider does not support structured extraction: minimax");
    // Refused before spending a call, not after failing at the JSON parser.
    expect(mocks.describeImagesWithModel).not.toHaveBeenCalled();
  });

  it("still allows single-image structured extraction on a split-response route", async () => {
    // One image gets the model's bare text back, with no `Image N:` prefix, so
    // it parses like any other provider and must not be blocked.
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: '{"summary":"ok"}',
      model: "MiniMax-VL-01",
    });

    await expect(
      extractStructuredWithImageModel(baseRequest({ provider: "minimax", model: "MiniMax-VL-01" })),
    ).resolves.toMatchObject({ parsed: { summary: "ok" }, contentType: "json" });
    expect(mocks.describeImagesWithModel).toHaveBeenCalledTimes(1);
  });

  it("leaves multi-image structured extraction alone on atomic routes", async () => {
    mocks.describeImagesWithModel.mockResolvedValueOnce({
      text: '{"summary":"ok"}',
      model: "claude-sonnet-5",
    });

    await expect(
      extractStructuredWithImageModel(baseRequest({ input: [baseImageInput(), baseImageInput()] })),
    ).resolves.toMatchObject({ parsed: { summary: "ok" } });
    expect(mocks.describeImagesWithModel).toHaveBeenCalledTimes(1);
  });
});
