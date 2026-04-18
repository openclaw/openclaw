import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { transformTransportMessages } from "./transport-message-transform.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildAssistantMessage(params: {
  provider: string;
  api: Api;
  model: string;
  content: AssistantMessage["content"];
  stopReason?: AssistantMessage["stopReason"];
}): AssistantMessage {
  return {
    role: "assistant",
    provider: params.provider,
    api: params.api,
    model: params.model,
    usage: ZERO_USAGE,
    stopReason: params.stopReason ?? "stop",
    timestamp: 0,
    content: params.content,
  };
}

function buildModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    ...overrides,
  } as Model<Api>;
}

describe("transformTransportMessages — thinking block preservation", () => {
  it("preserves a signed thinking block across cross-model replay (issue #24612, #25347)", () => {
    // Assistant message produced by anthropic/claude-sonnet-4-6 is being
    // replayed to google/gemini-2.5-pro. Under the old behavior the signed
    // thinking block was downgraded to `{ type: "text", text: <thinking> }`,
    // which invalidates the signature and produces a 400 on any subsequent
    // Anthropic retry path.
    const messages: Context["messages"] = [
      buildAssistantMessage({
        provider: "anthropic",
        api: "anthropic",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "thinking",
            thinking: "Let me think about this",
            thinkingSignature: "sig_abc123_opaque_bytes_from_anthropic",
          },
          { type: "text", text: "Here is my answer." },
        ],
      }),
    ];

    const out = transformTransportMessages(
      messages,
      buildModel({ provider: "google", api: "google-generative-ai", id: "gemini-2.5-pro" }),
    );
    const assistant = out[0] as AssistantMessage;
    const thinkingBlock = assistant.content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock).toMatchObject({
      type: "thinking",
      thinking: "Let me think about this",
      thinkingSignature: "sig_abc123_opaque_bytes_from_anthropic",
    });
    // Critically: no text-block downgrade of the signed thinking
    const downgradedText = assistant.content.find(
      (b) => b.type === "text" && b.text === "Let me think about this",
    );
    expect(downgradedText).toBeUndefined();
  });

  it("preserves a redacted thinking block across cross-model replay (issue #45010)", () => {
    const messages: Context["messages"] = [
      buildAssistantMessage({
        provider: "anthropic",
        api: "anthropic",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "thinking",
            thinking: "",
            redacted: true,
            thinkingSignature: "redacted_signature_blob",
          },
          { type: "text", text: "Visible reply." },
        ],
      }),
    ];

    const out = transformTransportMessages(
      messages,
      buildModel({ provider: "google", api: "google-generative-ai", id: "gemini-2.5-pro" }),
    );
    const assistant = out[0] as AssistantMessage;
    const redactedBlock = assistant.content.find(
      (b) => b.type === "thinking" && (b as { redacted?: boolean }).redacted === true,
    );
    expect(redactedBlock).toBeDefined();
  });

  it("still preserves signed thinking blocks on same-model replay (regression guard)", () => {
    const messages: Context["messages"] = [
      buildAssistantMessage({
        provider: "anthropic",
        api: "anthropic",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "thinking",
            thinking: "think",
            thinkingSignature: "sig",
          },
          { type: "text", text: "answer" },
        ],
      }),
    ];

    const out = transformTransportMessages(messages, buildModel());
    const assistant = out[0] as AssistantMessage;
    expect(assistant.content[0]).toMatchObject({
      type: "thinking",
      thinking: "think",
      thinkingSignature: "sig",
    });
  });

  it("still downgrades an UNSIGNED thinking block to text on cross-model replay", () => {
    // Unsigned thinking cannot be replayed to Anthropic verbatim (Anthropic
    // requires a signature), so the cross-model downgrade path is correct
    // for this case.
    const messages: Context["messages"] = [
      buildAssistantMessage({
        provider: "openai",
        api: "openai",
        model: "gpt-5.4",
        content: [
          { type: "thinking", thinking: "some reasoning without a signature" },
          { type: "text", text: "visible" },
        ],
      }),
    ];

    const out = transformTransportMessages(messages, buildModel());
    const assistant = out[0] as AssistantMessage;
    expect(assistant.content.find((b) => b.type === "thinking")).toBeUndefined();
    expect(
      assistant.content.find(
        (b) => b.type === "text" && b.text === "some reasoning without a signature",
      ),
    ).toBeDefined();
  });

  it("drops empty unsigned thinking blocks on cross-model replay", () => {
    const messages: Context["messages"] = [
      buildAssistantMessage({
        provider: "openai",
        api: "openai",
        model: "gpt-5.4",
        content: [
          { type: "thinking", thinking: "   \n  " },
          { type: "text", text: "visible" },
        ],
      }),
    ];

    const out = transformTransportMessages(messages, buildModel());
    const assistant = out[0] as AssistantMessage;
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content[0]).toMatchObject({ type: "text", text: "visible" });
  });
});
