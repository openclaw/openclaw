import { createServer, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { TINY_PNG_BASE64 } from "../../../../extensions/qa-lab/api.js";
import { readMockRequests, useMediaGateway } from "./media-gateway.test-support.js";
import { listen } from "./media-http.test-support.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const IMAGE_MODEL_REF = "openai/gpt-image-1";
const CONVERSATION = { id: "subagent-image-generation", kind: "direct" as const };
const PARENT_RELAY = "QA-SUBAGENT-IMAGE-PARENT-RELAY";
const waitFor = <T>(callback: () => T | Promise<T>, timeout = 60_000) =>
  vi.waitFor(callback, { interval: 100, timeout });

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startImageProvider() {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/images/generations") {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    request.resume();
    request.on("end", () => {
      requests += 1;
      writeJson(response, 200, { data: [{ b64_json: TINY_PNG_BASE64 }] });
    });
  });
  const listener = await listen(server);
  return { baseUrl: listener.url, requests: () => requests, stop: () => listener.stop() };
}

function configureImageProvider(config: OpenClawConfig, baseUrl: string): OpenClawConfig {
  const openAiProvider = config.models?.providers?.openai;
  if (!openAiProvider) {
    throw new Error("openai image provider is missing from QA gateway config");
  }
  const defaults = ((config.agents ??= {}).defaults ??= {});
  (defaults.mediaModels ??= {}).image = { primary: IMAGE_MODEL_REF };
  openAiProvider.baseUrl = `${baseUrl}/v1`;
  (openAiProvider.request ??= {}).allowPrivateNetwork = true;
  return config;
}

describe("subagent image generation", () => {
  const fixture = useMediaGateway();

  it("returns the child's generated image to its parent", async () => {
    const imageProvider = await startImageProvider();
    fixture.track(() => imageProvider.stop());
    const { state, transport, mock } = await fixture.start({
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      mutateConfig: (config) => configureImageProvider(config, imageProvider.baseUrl),
    });
    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text: "Subagent image QA parent: delegate the QA lighthouse image to a worker.",
    });
    const outbound = () =>
      state
        .getSnapshot()
        .messages.filter(
          (message) =>
            message.direction === "outbound" && message.conversation.id === CONVERSATION.id,
        );
    const images = () =>
      outbound().filter((message) =>
        message.attachments?.some(
          (attachment) =>
            attachment.kind === "image" && attachment.contentBase64 === TINY_PNG_BASE64,
        ),
      );
    await waitFor(() => expect(images()).not.toEqual([]), 120_000);
    expect(imageProvider.requests()).toBe(1);
    // Give any later turn on the ended child time to reach the model.
    await sleep(5_000);

    const requests = await readMockRequests(mock.baseUrl);
    const childSessionId = requests.find(
      (request) => request.plannedToolName === "image_generate",
    )?.sessionId;
    expect(childSessionId).toEqual(expect.any(String));
    const childRequests = requests.filter((request) => request.sessionId === childSessionId);
    const diagnostics = JSON.stringify({
      outbound: outbound().map((message) => [
        message.text?.slice(0, 80),
        message.attachments?.map((attachment) => attachment.kind),
      ]),
      childTurns: childRequests.map((request) => request.prompt.slice(-120)),
    });
    // The child's run is its task turn only: an image tool call, then its reply.
    expect(
      childRequests.map((request) => request.plannedToolName ?? "reply"),
      diagnostics,
    ).toEqual(["image_generate", "reply"]);
    // The parent relays the child's image, and the chat receives it once.
    expect(
      images().map((message) => message.text),
      diagnostics,
    ).toEqual([PARENT_RELAY]);
  }, 240_000);
});
