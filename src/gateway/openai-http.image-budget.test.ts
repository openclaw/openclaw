import { beforeEach, describe, expect, it, vi } from "vitest";

const extractImageContentFromSourceMock = vi.fn();

vi.mock("../media/input-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/input-files.js")>();
  return {
    ...actual,
    extractImageContentFromSource: (...args: unknown[]) =>
      extractImageContentFromSourceMock(...args),
  };
});

import { __testOnlyOpenAiHttp } from "./openai-http.js";

describe("openai image budget accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts normalized base64 image bytes against maxTotalImageBytes", async () => {
    extractImageContentFromSourceMock.mockResolvedValueOnce({
      type: "image",
      data: Buffer.alloc(10, 1).toString("base64"),
      mimeType: "image/jpeg",
    });

    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      maxTotalImageBytes: 5,
    });

    await expect(
      __testOnlyOpenAiHttp.resolveImagesForRequest(
        {
          urls: ["data:image/heic;base64,QUJD"],
        },
        limits,
      ),
    ).rejects.toThrow(/Total image payload too large/);
  });

  it("does not double-count unchanged base64 image payloads", async () => {
    extractImageContentFromSourceMock.mockResolvedValueOnce({
      type: "image",
      data: "QUJDRA==",
      mimeType: "image/jpeg",
    });

    const limits = __testOnlyOpenAiHttp.resolveOpenAiChatCompletionsLimits({
      maxTotalImageBytes: 4,
    });

    await expect(
      __testOnlyOpenAiHttp.resolveImagesForRequest(
        {
          urls: ["data:image/jpeg;base64,QUJDRA=="],
        },
        limits,
      ),
    ).resolves.toEqual([
      {
        type: "image",
        data: "QUJDRA==",
        mimeType: "image/jpeg",
      },
    ]);
  });

  it("honors x-openclaw-sender-is-owner=false", () => {
    const command = __testOnlyOpenAiHttp.buildAgentCommandInput({
      req: {
        headers: {
          "x-openclaw-sender-is-owner": "false",
        },
      } as never,
      prompt: { message: "hi" },
      sessionKey: "agent:main:test",
      runId: "run-1",
      messageChannel: "webchat",
    });

    expect(command.senderIsOwner).toBe(false);
  });

  it("defaults public-mode ingress to non-owner when the header is missing", () => {
    const command = __testOnlyOpenAiHttp.buildAgentCommandInput({
      req: { headers: {} } as never,
      prompt: { message: "hi" },
      sessionKey: "agent:main:test",
      runId: "run-1",
      messageChannel: "webchat",
      publicMode: true,
    });

    expect(command.senderIsOwner).toBe(false);
  });

  it("ignores x-openclaw-sender-is-owner=true from an untrusted caller", () => {
    const command = __testOnlyOpenAiHttp.buildAgentCommandInput({
      req: {
        headers: {
          "x-openclaw-sender-is-owner": "true",
        },
        socket: { remoteAddress: "203.0.113.9" },
      } as never,
      prompt: { message: "hi" },
      sessionKey: "agent:main:test",
      runId: "run-1",
      messageChannel: "webchat",
      publicMode: true,
      trustedProxies: ["127.0.0.1"],
    });

    expect(command.senderIsOwner).toBe(false);
  });

  it("honors x-openclaw-sender-is-owner=true from a trusted proxy", () => {
    const command = __testOnlyOpenAiHttp.buildAgentCommandInput({
      req: {
        headers: {
          "x-openclaw-sender-is-owner": "true",
        },
        socket: { remoteAddress: "127.0.0.1" },
      } as never,
      prompt: { message: "hi" },
      sessionKey: "agent:main:test",
      runId: "run-1",
      messageChannel: "webchat",
      publicMode: true,
      trustedProxies: ["127.0.0.1"],
    });

    expect(command.senderIsOwner).toBe(true);
  });
});
