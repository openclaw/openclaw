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

import { extractStructuredWithImageModel } from "./structured-extraction.js";

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
});
