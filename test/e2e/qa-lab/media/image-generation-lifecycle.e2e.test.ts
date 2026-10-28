import { createServer, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  TINY_PNG_BASE64,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { resolveRuntimePolicySessionKey } from "../../../../src/auto-reply/reply/runtime-policy-session-key.js";
import { readMockRequests, useMediaGateway } from "./media-gateway.test-support.js";
import { listen } from "./media-http.test-support.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const IMAGE_MODEL_REF = "openai/gpt-image-1";
const REQUEST_TEXT =
  "Image generation check IMAGE_TASK_LIFECYCLE: generate the QA lighthouse image.";
const CONVERSATION = { id: "image-generation-lifecycle", kind: "direct" as const };
const waitFor = <T>(callback: () => T, timeout = 30_000) =>
  vi.waitFor(callback, { interval: 50, timeout });
// QA direct chats share a transcript, but each peer owns its media tasks.
const REQUESTER_SESSION_KEY = resolveRuntimePolicySessionKey({
  sessionKey: "agent:qa:main",
  ctx: {
    Provider: "qa-channel",
    AccountId: "default",
    ChatType: "direct",
    SenderId: CONVERSATION.id,
  },
});

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startControlledImageProvider() {
  const requests: Record<string, unknown>[] = [];
  const pendingResponses = new Set<ServerResponse>();
  let released = false;

  const complete = (response: ServerResponse) => {
    pendingResponses.delete(response);
    writeJson(response, 200, {
      data: [
        {
          b64_json: TINY_PNG_BASE64,
          revised_prompt: "A QA lighthouse with a tiny protocol droid silhouette.",
        },
      ],
    });
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/images/generations") {
        writeJson(response, 404, { error: "not found" });
        return;
      }
      const body = JSON.parse(await text(request)) as Record<string, unknown>;
      requests.push(body);
      if (released) {
        complete(response);
        return;
      }
      pendingResponses.add(response);
    })().catch((error: unknown) => {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  const listener = await listen(server);
  const release = () => {
    released = true;
    for (const response of pendingResponses) {
      complete(response);
    }
  };

  return {
    baseUrl: listener.url,
    requests,
    release,
    async stop() {
      release();
      await listener.stop();
    },
  };
}

function configureImageProvider(
  config: OpenClawConfig,
  imageProviderBaseUrl: string,
): OpenClawConfig {
  const openAiProvider = config.models?.providers?.openai;
  if (!openAiProvider) {
    throw new Error("openai image provider is missing from QA gateway config");
  }
  const defaults = ((config.agents ??= {}).defaults ??= {});
  (defaults.mediaModels ??= {}).image = { primary: IMAGE_MODEL_REF };
  openAiProvider.baseUrl = `${imageProviderBaseUrl}/v1`;
  (openAiProvider.request ??= {}).allowPrivateNetwork = true;
  return config;
}

async function waitForToolOutput(baseUrl: string, needle: string) {
  return waitFor(async () => {
    const matched = (await readMockRequests(baseUrl)).find(
      (request) =>
        request.allInputText.includes("IMAGE_TASK_LIFECYCLE") &&
        request.toolOutput.includes(needle),
    );
    expect(matched).toBeDefined();
    return matched as MockOpenAiRequestSnapshot;
  });
}

async function readImageTaskStatus(gateway: {
  call: (method: string, params: unknown) => Promise<unknown>;
}) {
  const result = (await gateway.call("tools.invoke", {
    name: "image_generate",
    args: { action: "status" },
    sessionKey: REQUESTER_SESSION_KEY,
  })) as { ok?: boolean; output?: unknown; result?: unknown };
  return JSON.stringify(result);
}

describe("image generation task lifecycle through QA-channel", () => {
  const fixture = useMediaGateway();

  it("deduplicates requests and labels internal completion provenance", async () => {
    const imageProvider = await startControlledImageProvider();
    fixture.track(() => imageProvider.stop());
    const { state, transport, mock, gateway } = await fixture.start({
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      mutateConfig: (config) => configureImageProvider(config, imageProvider.baseUrl),
    });

    const sendExactRequest = () =>
      transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: CONVERSATION.id,
        text: REQUEST_TEXT,
      });

    await sendExactRequest();
    await waitFor(() => expect(imageProvider.requests).toHaveLength(1));

    await sendExactRequest();
    const runningDuplicate = await waitForToolOutput(mock.baseUrl, "is already running");
    const runningReceipt = runningDuplicate.toolOutput.match(
      /Image generation task (\S+) is already running/u,
    )?.[1];
    expect(runningReceipt).toEqual(expect.any(String));
    expect(imageProvider.requests).toHaveLength(1);
    expect(await readImageTaskStatus(gateway)).toContain(runningReceipt);
    imageProvider.release();
    await waitFor(() => {
      const completions = state
        .getSnapshot()
        .messages.filter(
          (message) =>
            message.direction === "outbound" &&
            message.conversation.id === CONVERSATION.id &&
            message.attachments?.some(
              (attachment) =>
                attachment.kind === "image" &&
                attachment.mimeType === "image/png" &&
                attachment.contentBase64 === TINY_PNG_BASE64,
            ),
        );
      expect(completions).toHaveLength(1);
    }, 90_000);

    const completionReentry = await waitFor(async () => {
      const request = (await readMockRequests(mock.baseUrl)).find(
        (snapshot) =>
          snapshot.allInputText.includes("[Inter-session message]") &&
          snapshot.allInputText.includes("sourceTool=image_generate"),
      );
      if (!request) {
        throw new Error("image completion did not re-enter the agent session");
      }
      return request;
    });
    expect(completionReentry.allInputText).toContain("sourceChannel=internal");

    // Completion delivery precedes the terminal task state; wait for it before the next duplicate.
    await waitFor(async () =>
      expect(await readImageTaskStatus(gateway)).toContain(
        "No active image generation task is currently running",
      ),
    );

    await sendExactRequest();
    const completedDuplicate = await waitForToolOutput(mock.baseUrl, "recently succeeded");
    expect(completedDuplicate.toolOutput).toContain(runningReceipt);

    const plannedCalls = (await readMockRequests(mock.baseUrl)).filter(
      (request) =>
        request.allInputText.includes("IMAGE_TASK_LIFECYCLE") &&
        request.plannedToolName === "image_generate",
    );
    expect(plannedCalls).toHaveLength(3);
    expect(plannedCalls.map((request) => request.plannedToolArgs)).toEqual([
      plannedCalls[0]?.plannedToolArgs,
      plannedCalls[0]?.plannedToolArgs,
      plannedCalls[0]?.plannedToolArgs,
    ]);
    expect(imageProvider.requests).toHaveLength(1);
    const completionOutcomes = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          message.conversation.id === CONVERSATION.id &&
          message.attachments?.some((attachment) => attachment.kind === "image"),
      );
    expect(completionOutcomes).toHaveLength(1);
  }, 180_000);
});
