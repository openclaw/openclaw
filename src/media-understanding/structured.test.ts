// Covers the generic model-backed structured extraction fallback: forwarding
// into the shared image path, prompt composition, and result normalization.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { extractStructuredWithModelFallbackCore } from "./structured.js";
import type { StructuredExtractionRequest } from "./types.js";

const mocks = vi.hoisted(() => ({
  describeImagesWithModelCore: vi.fn<
    (req: Record<string, unknown>) => Promise<{ text: string; model?: string }>
  >(async () => ({
    text: '{"name":"lamp"}',
    model: "resolved-model",
  })),
}));

vi.mock("./image.js", () => ({
  describeImagesWithModelCore: mocks.describeImagesWithModelCore,
}));

const SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
};

function buildRequest(
  overrides: Partial<StructuredExtractionRequest> = {},
): StructuredExtractionRequest {
  return {
    input: [
      { type: "image", buffer: Buffer.from("image-bytes"), fileName: "a.png", mime: "image/png" },
    ],
    instructions: "Extract the object name.",
    schemaName: "object.name",
    jsonSchema: SCHEMA,
    timeoutMs: 30_000,
    profile: "vision-profile",
    preferredProfile: "vision-fallback",
    agentDir: "/tmp/agent",
    cfg: {} as OpenClawConfig,
    model: "claude-sonnet-5",
    provider: "anthropic",
    ...overrides,
  };
}

describe("extractStructuredWithModelFallbackCore", () => {
  it("forwards images and auth params to the shared image path and returns validated JSON", async () => {
    mocks.describeImagesWithModelCore.mockClear();
    const signal = new AbortController().signal;
    const request = buildRequest({
      input: [
        { type: "text", text: "The label says Fiat Lux." },
        { type: "image", buffer: Buffer.from("image-bytes"), fileName: "a.png", mime: "image/png" },
        { type: "image", buffer: Buffer.from("more-bytes"), fileName: "b.jpg", mime: "image/jpeg" },
      ],
      signal,
    });

    const result = await extractStructuredWithModelFallbackCore(request);

    expect(mocks.describeImagesWithModelCore).toHaveBeenCalledTimes(1);
    const call = mocks.describeImagesWithModelCore.mock.calls[0]?.[0] ?? {};
    expect(call.images).toEqual([
      { buffer: Buffer.from("image-bytes"), fileName: "a.png", mime: "image/png" },
      { buffer: Buffer.from("more-bytes"), fileName: "b.jpg", mime: "image/jpeg" },
    ]);
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-sonnet-5");
    expect(call.timeoutMs).toBe(30_000);
    expect(call.signal).toBe(signal);
    expect(call.profile).toBe("vision-profile");
    expect(call.preferredProfile).toBe("vision-fallback");
    expect(call.agentDir).toBe("/tmp/agent");
    const prompt = call.prompt as string;
    expect(prompt).toContain("Extract the object name.");
    expect(prompt).toContain("Schema name: object.name");
    expect(prompt).toContain(`JSON schema:\n${JSON.stringify(SCHEMA)}`);
    expect(prompt).toContain("Return valid JSON only. Do not wrap the JSON in Markdown fences.");
    expect(prompt.endsWith("The label says Fiat Lux.")).toBe(true);
    expect(result).toEqual({
      text: '{"name":"lamp"}',
      parsed: { name: "lamp" },
      model: "resolved-model",
      provider: "anthropic",
      contentType: "json",
    });
  });

  it("returns plain text without parsing when jsonMode is false", async () => {
    mocks.describeImagesWithModelCore.mockResolvedValueOnce({
      text: "a brass lamp",
      model: undefined,
    });

    const result = await extractStructuredWithModelFallbackCore(buildRequest({ jsonMode: false }));

    const call = mocks.describeImagesWithModelCore.mock.calls.at(-1)?.[0] ?? {};
    expect(call.prompt).toContain("Return the extraction as concise text.");
    expect(result).toEqual({
      text: "a brass lamp",
      model: "claude-sonnet-5",
      provider: "anthropic",
      contentType: "text",
    });
  });

  it("rejects when the model returns invalid JSON", async () => {
    mocks.describeImagesWithModelCore.mockResolvedValueOnce({ text: "not json", model: "m" });

    await expect(extractStructuredWithModelFallbackCore(buildRequest())).rejects.toThrow(
      "Structured extraction returned invalid JSON.",
    );
  });

  it("rejects when the JSON does not match the schema", async () => {
    mocks.describeImagesWithModelCore.mockResolvedValueOnce({ text: '{"name":7}', model: "m" });

    await expect(extractStructuredWithModelFallbackCore(buildRequest())).rejects.toThrow(
      /Structured extraction JSON did not match schema/,
    );
  });

  it("rejects invalid requests before calling the model", async () => {
    mocks.describeImagesWithModelCore.mockClear();

    await expect(
      extractStructuredWithModelFallbackCore(buildRequest({ model: "  " })),
    ).rejects.toThrow("Structured extraction requires model id.");
    await expect(
      extractStructuredWithModelFallbackCore(buildRequest({ instructions: " " })),
    ).rejects.toThrow("Structured extraction requires instructions.");
    await expect(
      extractStructuredWithModelFallbackCore(buildRequest({ input: [] })),
    ).rejects.toThrow("Structured extraction requires at least one input.");
    await expect(
      extractStructuredWithModelFallbackCore(
        buildRequest({ input: [{ type: "text", text: "only text" }] }),
      ),
    ).rejects.toThrow("Structured extraction requires at least one image input.");
    expect(mocks.describeImagesWithModelCore).not.toHaveBeenCalled();
  });
});
