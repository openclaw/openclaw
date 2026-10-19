import { FILE_TYPE_SNIFF_MAX_BYTES } from "@openclaw/media-core/mime";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { getAiTransportHost } from "../../packages/ai/src/host.js";
import { convertMessages } from "../../packages/ai/src/openai-completions-messages.js";
import { streamSimpleAnthropic } from "../../packages/ai/src/providers/anthropic.js";
import { extractToolResultText } from "../../packages/ai/src/providers/tool-result-text.js";
import { resolveOpenAICompletionsCompat } from "../../packages/ai/src/transports/openai-completions-compat.js";
import type { Context, Model, ToolResultMessage } from "../../packages/ai/src/types.js";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import { createOpenClawReadTool } from "../agents/agent-tools.read.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  createSolidPngBuffer,
  createTinyJpegBuffer,
} from "../plugin-sdk/test-helpers/image-fixtures.js";
import "./ai-transport-host.js";

afterEach(resetSecretRedactionRegistryForTest);

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
const userMessage = (content: unknown[]) => ({ role: "user", content });
const toolImageContent = <T>(image: T) => [
  textBlock("before tool image"),
  image,
  textBlock("after tool image"),
];

function toolExchange(content: ToolResultMessage["content"]): Context["messages"] {
  const id = "call-1";
  return [
    {
      role: "assistant",
      api: anthropicModel.api,
      provider: anthropicModel.provider,
      model: anthropicModel.id,
      content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      usage: createZeroUsageFixture(),
      stopReason: "toolUse",
      timestamp: 1,
    },
    { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: 2 },
  ];
}

async function captureAnthropic(context: Context, model = anthropicModel) {
  let payload: unknown;
  const stream = streamSimpleAnthropic(model, context, {
    apiKey: "test-provider-key",
    reasoning: "off",
    onPayload: (value) => {
      payload = value;
      throw new Error("payload captured");
    },
  });
  const result = await stream.result();
  return { payload, result };
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
  const fetchPolicy = vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(network);
  try {
    const { payload, result } = await captureAnthropic(
      {
        messages: [
          {
            role: "user",
            timestamp: 0,
            content: [
              { type: "text", text: "user image" },
              imageBlock(` ${jpegData.slice(0, 80)}\n${jpegData.slice(80)} `, "image/png"),
            ],
          },
          ...toolExchange(toolImageContent(imageBlock(pngData.replace(/=+$/, ""), "image/jpeg"))),
        ],
      },
      { ...anthropicModel, input: ["text", "image"] },
    );
    expect(result.stopReason).toBe("error");
    expect(network).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      messages: [
        userMessage([textBlock("user image"), wireImage(jpegData, "image/jpeg")]),
        { role: "assistant", content: [{ type: "tool_use", id: "call-1" }] },
        userMessage([
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: toolImageContent(wireImage(pngData, "image/png")),
          },
        ]),
      ],
    });
  } finally {
    fetchPolicy.mockRestore();
  }
});

it.each([false, true])("redacts nested codes only when registered (%s)", (registered) => {
  if (registered) {
    registerSecretValueForRedaction("EAI_AGAIN");
  }
  const cause = Object.assign(new Error("getaddrinfo failed at fixture.invalid"), {
    code: "EAI_AGAIN",
    authorization: "Bearer fixture-sensitive-authorization",
  });
  const projected = projectProviderError(new Error("Connection error.", { cause }));
  expect(projected).toEqual(
    registered
      ? expect.not.objectContaining({ errorCode: "EAI_AGAIN" })
      : {
          stopReason: "error",
          errorMessage: "Connection error.",
          errorCode: "EAI_AGAIN",
        },
  );
});

it("redacts registered opaque secrets from ordinary provider error messages", () => {
  const secret = "opaque-configured-provider-value";
  registerSecretValueForRedaction(secret);
  const message = `provider rejected configured value ${secret}`;
  const projected = projectProviderError({ message });
  expect(projected.errorMessage).toContain("provider rejected configured value");
  expect(projected.errorMessage).not.toContain(secret);
});

it("carries original tool results into Anthropic and OpenAI-compatible payloads", async () => {
  const files: Record<string, string> = {
    "settings.yaml": "api_key: unquoted-provider-config-credential-1234567890",
    "production.env": "API_KEY=provider-env-credential-1234567890",
    "settings.py": "API_TOKEN = computeToken()\nAPI_KEY: str = computeKey()\napi_key: ConfigValue",
  };
  const readTool = createOpenClawReadTool({
    name: "read",
    label: "read",
    description: "test read",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_toolCallId, args: { path: string }) => {
      const text = files[args.path];
      if (text === undefined) {
        throw new Error(`Unexpected fixture path: ${args.path}`);
      }
      return {
        content: [textBlock(text)],
        details: { kind: "text", content: text },
      };
    },
  });
  const fileTexts: string[] = [];
  for (const path of Object.keys(files)) {
    const result = await readTool.execute(`read-${path}`, { path });
    fileTexts.push(extractToolResultText(result.content));
  }
  const providerText = [
    extractToolResultText([
      {
        type: "resource",
        source: "if let token = timeObserverToken {",
        jsonSource: '{"token":"timeObserverToken"}',
        api_key: "provider-secret-value",
      },
    ]),
    ...fileTexts,
  ].join("\n");
  const context: Context = {
    messages: toolExchange([textBlock(providerText)]),
  };
  const { payload: anthropicPayload } = await captureAnthropic(context);

  const openAiModel = {
    ...anthropicModel,
    id: "openai-compatible-test",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  } satisfies Model<"openai-completions">;
  const openAiPayload = convertMessages(
    openAiModel,
    context,
    resolveOpenAICompletionsCompat(openAiModel),
  );

  for (const payload of [anthropicPayload, openAiPayload]) {
    const serialized = JSON.stringify(payload);
    for (const text of [
      "if let token = timeObserverToken {",
      String.raw`\\\"token\\\":\\\"timeObserverToken\\\"`,
      "provider-secret-value",
      ...Object.values(files).flatMap((source) => source.split("\n")),
    ]) {
      expect(serialized).toContain(text);
    }
  }
});
