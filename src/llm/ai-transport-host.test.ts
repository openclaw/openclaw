import { FILE_TYPE_SNIFF_MAX_BYTES } from "@openclaw/media-core/mime";
import { afterEach, expect, it, vi } from "vitest";
import { getAiTransportHost } from "../../packages/ai/src/host.js";
import { convertMessages } from "../../packages/ai/src/openai-completions-messages.js";
import { streamSimpleAnthropic } from "../../packages/ai/src/providers/anthropic.js";
import { resolveOpenAICompletionsCompat } from "../../packages/ai/src/transports/openai-completions-compat.js";
import type { Context, Model, ToolResultMessage } from "../../packages/ai/src/types.js";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  createSolidPngBuffer,
  createTinyJpegBuffer,
} from "../plugin-sdk/test-helpers/image-fixtures.js";
import "./ai-transport-host.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  vi.restoreAllMocks();
});

const anthropicModel = makeProviderModelFixture<"anthropic-messages">({
  id: "claude-test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
});

const textBlock = (text: string) => ({ type: "text" as const, text });
const imageBlock = (data: string, mimeType: string) => ({ type: "image" as const, data, mimeType });
const wireImage = (data: string, media_type: string) => ({
  type: "image",
  source: { type: "base64", media_type, data },
});
const toolImageContent = <T>(image: T) => [
  textBlock("before tool image"),
  image,
  textBlock("after tool image"),
];

function toolExchange(content: ToolResultMessage["content"]): Context["messages"] {
  const id = "call-1";
  return [
    makeAgentAssistantMessage({
      api: anthropicModel.api,
      provider: anthropicModel.provider,
      model: anthropicModel.id,
      content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      stopReason: "toolUse",
      timestamp: 1,
    }),
    { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: 2 },
  ];
}

async function captureAnthropic(context: Context, model = anthropicModel) {
  let payload: unknown;
  await streamSimpleAnthropic(model, context, {
    apiKey: "test-provider-key",
    reasoning: "off",
    onPayload: (value) => {
      payload = value;
      throw new Error("payload captured");
    },
  }).result();
  return payload;
}

it("keeps complete canonical user and tool-result images through the installed host", async () => {
  const jpeg = Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES + 32);
  createTinyJpegBuffer().copy(jpeg);
  jpeg.write("user-image-tail", jpeg.length - 15);
  const png = Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES + 33);
  createSolidPngBuffer(1, 1, { r: 18, g: 52, b: 86 }).copy(png);
  png.write("tool-image-tail", png.length - 15);
  const jpegData = jpeg.toString("base64");
  const pngData = png.toString("base64");
  const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("unexpected network"));
  vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(network);
  const payload = await captureAnthropic(
    {
      messages: [
        makeAgentUserMessage({
          content: [
            textBlock("user image"),
            imageBlock(` ${jpegData.slice(0, 80)}\n${jpegData.slice(80)} `, "image/png"),
          ],
        }),
        ...toolExchange(toolImageContent(imageBlock(pngData.replace(/=+$/, ""), "image/jpeg"))),
      ],
    },
    { ...anthropicModel, input: ["text", "image"] },
  );
  expect(network).not.toHaveBeenCalled();
  expect(payload).toMatchObject({
    messages: [
      {
        role: "user",
        content: [textBlock("user image"), wireImage(jpegData, "image/jpeg")],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1" }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: toolImageContent(wireImage(pngData, "image/png")),
          },
        ],
      },
    ],
  });
});

it.each([false, true])("redacts nested codes only when registered (%s)", (registered) => {
  if (registered) {
    registerSecretValueForRedaction("EAI_AGAIN");
  }
  const cause = Object.assign(new Error("DNS lookup failed"), { code: "EAI_AGAIN" });
  const projected = projectProviderError(new Error("Connection error.", { cause }));
  expect(projected).toMatchObject({ stopReason: "error", errorMessage: "Connection error." });
  expect(projected.errorCode === "EAI_AGAIN").toBe(!registered);
});

it("redacts registered opaque secrets from ordinary provider error messages", () => {
  const secret = "opaque-configured-provider-value";
  registerSecretValueForRedaction(secret);
  const projected = projectProviderError({ message: `provider rejected ${secret}` });
  expect(projected.errorMessage).toContain("provider rejected");
  expect(projected.errorMessage).not.toContain(secret);
});

it("carries original tool results into Anthropic and OpenAI-compatible payloads", async () => {
  const source =
    'api_key: provider-secret-value\nAPI_TOKEN = computeToken()\n{"token":"timeObserverToken"}';
  const context: Context = { messages: toolExchange([{ type: "text", text: source }]) };
  const anthropicPayload = await captureAnthropic(context);

  const openAiModel = {
    ...anthropicModel,
    id: "openai-compatible-test",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  } satisfies Model<"openai-completions">;
  for (const payload of [
    anthropicPayload,
    convertMessages(openAiModel, context, resolveOpenAICompletionsCompat(openAiModel)),
  ]) {
    expect(JSON.stringify(payload)).toContain(JSON.stringify(source).slice(1, -1));
  }
});

it.each(
  ["EAI_AGAIN", "CERT_REVOKED"].flatMap((code) =>
    [false, true].map((registered) => ({ code, registered })),
  ),
)("redacts nested fetch $code only when registered ($registered)", ({ code, registered }) => {
  if (registered) {
    registerSecretValueForRedaction(code);
  }
  const cause = new TypeError("fetch failed", {
    cause: Object.assign(new Error("fixture transport failure"), {
      code,
      authorization: "Bearer fixture-sensitive-authorization",
    }),
  });
  const projected = projectProviderError(new Error("Connection error.", { cause }));
  expect(projected).toEqual(
    registered
      ? expect.not.objectContaining({ errorCode: code })
      : {
          stopReason: "error",
          errorMessage: "Connection error.",
          errorCode: code,
        },
  );
  expect(JSON.stringify(projected)).not.toContain("fixture-sensitive-authorization");
});
