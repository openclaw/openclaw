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
  name: "Claude test",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  maxTokens: 1_024,
});

const textBlock = (text: string) => ({ type: "text" as const, text });
const wireImage = (data: string, media_type: string) => ({
  type: "image",
  source: { type: "base64", media_type, data },
});

function toolExchange(content: ToolResultMessage["content"], id = "call-1"): Context["messages"] {
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

async function captureAnthropic(
  context: Context,
  model: Model<"anthropic-messages"> = anthropicModel,
) {
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
              {
                type: "image",
                data: ` ${jpegData.slice(0, 80)}\n${jpegData.slice(80)} `,
                mimeType: "image/png",
              },
            ],
          },
          ...toolExchange(
            [
              textBlock("before tool image"),
              { type: "image", data: pngData.replace(/=+$/, ""), mimeType: "image/jpeg" },
              textBlock("after tool image"),
            ],
            "image-1",
          ),
        ],
      },
      { ...anthropicModel, input: ["text", "image"] },
    );
    expect(result.stopReason).toBe("error");
    expect(network).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      messages: [
        {
          role: "user",
          content: [textBlock("user image"), wireImage(jpegData, "image/jpeg")],
        },
        { role: "assistant", content: [{ type: "tool_use", id: "image-1" }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "image-1",
              content: [
                textBlock("before tool image"),
                wireImage(pngData, "image/png"),
                textBlock("after tool image"),
              ],
            },
          ],
        },
      ],
    });
  } finally {
    fetchPolicy.mockRestore();
  }
});

it("preserves a nested transport code after installed host redaction", () => {
  const cause = Object.assign(new Error("getaddrinfo failed at fixture.invalid"), {
    code: "EAI_AGAIN",
    authorization: "Bearer fixture-sensitive-authorization",
  });
  const projected = projectProviderError(new Error("Connection error.", { cause }));
  expect(projected).toEqual({
    stopReason: "error",
    errorMessage: "Connection error.",
    errorCode: "EAI_AGAIN",
  });
});

it("keeps registered transport strings secret in provider errors", () => {
  registerSecretValueForRedaction("EAI_AGAIN");
  const cause = Object.assign(new Error("lookup failed"), { code: "EAI_AGAIN" });
  expect(projectProviderError(new Error("Connection error.", { cause })).errorCode).not.toBe(
    "EAI_AGAIN",
  );
});

it("redacts registered opaque secrets from ordinary provider error messages", () => {
  const secret = "opaque-configured-provider-value";
  registerSecretValueForRedaction(secret);

  const projected = projectProviderError({
    message: `provider rejected configured value ${secret}`,
  });

  expect(projected.errorMessage).toContain("provider rejected configured value");
  expect(projected.errorMessage).not.toContain(secret);
});

it("carries original tool results into Anthropic and OpenAI-compatible payloads", async () => {
  const configCredential = "unquoted-provider-config-credential-1234567890";
  const envCredential = "provider-env-credential-1234567890";
  const sourceLines = [
    "API_TOKEN = computeToken()",
    "API_KEY: str = computeKey()",
    "api_key: ConfigValue",
  ];
  const files: Record<string, string> = {
    "settings.yaml": `api_key: ${configCredential}`,
    "production.env": `API_KEY=${envCredential}`,
    "settings.py": sourceLines.join("\n"),
  };
  const readTool = createOpenClawReadTool({
    name: "read",
    label: "read",
    description: "test read",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_toolCallId, args: { path: string }) => {
      const text = files[args.path];
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
    name: "OpenAI-compatible test",
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
    expect(serialized).toContain("if let token = timeObserverToken {");
    expect(serialized).toContain(String.raw`\\\"token\\\":\\\"timeObserverToken\\\"`);
    for (const sourceLine of sourceLines) {
      expect(serialized).toContain(sourceLine);
    }
    expect(serialized).toContain("provider-secret-value");
    expect(serialized).toContain(configCredential);
    expect(serialized).toContain(envCredential);
  }
});
