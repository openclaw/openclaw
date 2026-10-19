import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import type { MockOpenAiRequestSnapshot } from "../../../../extensions/qa-lab/api.js";
import { readMockRequests, useMediaGateway } from "./media-gateway.test-support.js";

const ACTIVE_MODEL_ID = "gpt-5.6-luna";
const ACTIVE_MODEL_REF = `mock-openai/${ACTIVE_MODEL_ID}`;
const IMAGE_MODEL_ID = "gpt-5.6-luna-alt";
const IMAGE_MODEL_REF = `mock-openai/${IMAGE_MODEL_ID}`;
const SCENARIO_MARKER = "VISION_CHANNEL_OFFLOAD";
const FINAL_REPLY = "QA_VISION_CHANNEL_OFFLOAD_OK";
const PROVIDER_SUMMARY =
  "Protocol note: the attached image is split horizontally, with red on top and blue on the bottom.";
const IMAGE_PROMPT = `Image understanding check ${SCENARIO_MARKER}: describe the top and bottom colors.`;
const SPLIT_COLOR_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==";
const CONVERSATION = { id: "vision-channel-offload", kind: "direct" as const };

function configureVisionOffload(config: OpenClawConfig): OpenClawConfig {
  const provider = config.models?.providers?.["mock-openai"];
  if (!provider) {
    throw new Error("mock-openai provider is missing from QA gateway config");
  }
  let foundActiveModel = false;
  const models = provider.models.map((model) => {
    if (model.id !== ACTIVE_MODEL_ID) {
      return model;
    }
    foundActiveModel = true;
    return { ...model, input: ["text" as const] };
  });
  if (!foundActiveModel) {
    throw new Error(`active QA model is missing from provider catalog: ${ACTIVE_MODEL_ID}`);
  }

  ((config.agents ??= {}).defaults ??= {}).imageModel = { primary: IMAGE_MODEL_REF };
  provider.models = models;
  (((config.tools ??= {}).media ??= {}).image ??= {}).prompt = IMAGE_PROMPT;
  return config;
}

function compactRequestShapes(requests: MockOpenAiRequestSnapshot[]) {
  return requests.map((request) => ({
    cursor: request.cursor,
    model: request.model,
    imageInputCount: request.imageInputCount,
    inputRoles: readInputRoles(request),
    instructions: request.instructions?.slice(0, 240),
    allInputTextTail: request.allInputText.slice(-400),
  }));
}

function readInputRoles(request: MockOpenAiRequestSnapshot) {
  const input = Array.isArray(request.body.input) ? request.body.input : [];
  return input.flatMap((item) =>
    item && typeof item === "object" && typeof (item as { role?: unknown }).role === "string"
      ? [(item as { role: string }).role]
      : [],
  );
}

describe("QA-channel vision offload", () => {
  const fixture = useMediaGateway();

  it("summarizes an image before the text-only active model replies once", async () => {
    const { state, transport, mock, gateway } = await fixture.start({
      primaryModel: ACTIVE_MODEL_REF,
      alternateModel: IMAGE_MODEL_REF,
      mutateConfig: configureVisionOffload,
    });

    const cursorResponse = await fetch(`${mock.baseUrl}/debug/request-cursor`);
    const cursorBody = (await cursorResponse.json()) as { cursor?: unknown };
    expect(cursorResponse.ok).toBe(true);
    expect(typeof cursorBody.cursor).toBe("number");
    const requestCursor = cursorBody.cursor as number;

    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: `${SCENARIO_MARKER}: use the image description and reply exactly ${FINAL_REPLY}.`,
      attachments: [
        {
          id: "split-color-image",
          kind: "image",
          mimeType: "image/png",
          fileName: "red-top-blue-bottom.png",
          contentBase64: SPLIT_COLOR_PNG_BASE64,
        },
      ],
    });

    let finalOutbound;
    try {
      finalOutbound = await transport.waitForOutbound({
        conversation: CONVERSATION,
        textIncludes: FINAL_REPLY,
        timeoutMs: 90_000,
      });
    } catch (error) {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    }

    const scenarioRequests = (await readMockRequests(mock.baseUrl, requestCursor)).filter(
      (request) => request.allInputText.includes(SCENARIO_MARKER),
    );
    const requestDiagnostics = `requests=${JSON.stringify(compactRequestShapes(scenarioRequests))}`;
    expect(scenarioRequests, requestDiagnostics).toHaveLength(2);

    const [imageRequest, activeModelRequest] = scenarioRequests;
    if (!imageRequest || !activeModelRequest) {
      throw new Error(requestDiagnostics);
    }
    expect(imageRequest, requestDiagnostics).toMatchObject({
      model: IMAGE_MODEL_ID,
      imageInputCount: 1,
    });
    expect(readInputRoles(imageRequest), requestDiagnostics).toEqual(["developer", "user"]);
    expect(activeModelRequest, requestDiagnostics).toMatchObject({
      model: ACTIVE_MODEL_ID,
      imageInputCount: 0,
    });
    expect(readInputRoles(activeModelRequest), requestDiagnostics).toEqual([
      "developer",
      "user",
      "user",
    ]);
    expect(imageRequest.cursor, requestDiagnostics).toBeLessThan(activeModelRequest.cursor);
    expect(imageRequest.allInputText, requestDiagnostics).toContain(IMAGE_PROMPT);
    expect(activeModelRequest.allInputText, requestDiagnostics).toContain(PROVIDER_SUMMARY);
    expect(activeModelRequest.allInputText, requestDiagnostics).toContain(
      "OpenClaw runtime context:\n",
    );

    const visibleOutbound = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          message.accountId === "default" &&
          message.conversation.id === CONVERSATION.id &&
          message.conversation.kind === CONVERSATION.kind &&
          !message.deleted,
      );
    expect(visibleOutbound).toHaveLength(1);
    expect(visibleOutbound[0]).toMatchObject({
      id: finalOutbound.id,
      text: FINAL_REPLY,
    });
  }, 180_000);
});
