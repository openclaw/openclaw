import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi, type Mock } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import * as inputFiles from "../media/input-files.js";
import { IMAGE_ONLY_USER_MESSAGE } from "./agent-prompt.js";
import type { agentCommandMock as sharedAgentCommandMock } from "./test-helpers.runtime-state.js";

type PostRequest = (port: number, body: unknown) => Promise<Response>;

type HttpMediaSuite = {
  getPort: () => number;
  agentCommandMock: typeof sharedAgentCommandMock;
};

type OpenAiMediaSuite = HttpMediaSuite & {
  postChatCompletions: PostRequest;
  firstAgentCommandOptions: () =>
    | {
        message?: string;
        images?: Array<{ data: string; mimeType: string; type: string }>;
      }
    | undefined;
};

type OpenResponsesMediaSuite = HttpMediaSuite & {
  postResponses: PostRequest;
  firstAgentOpts: () => Record<string, unknown>;
};

function publishUploads(enabled: boolean | undefined) {
  const config = getRuntimeConfig();
  setRuntimeConfigSnapshot({
    ...config,
    gateway: { ...config.gateway, uploads: enabled === undefined ? undefined : { enabled } },
  });
}

export function registerOpenAiHttpUploadTests({
  getPort,
  postChatCompletions,
  firstAgentCommandOptions,
  agentCommandMock,
}: OpenAiMediaSuite): void {
  describe("gateway upload policy", () => {
    const imagePart = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,QUJDRA==" },
    };

    it.each([undefined, true])("allows image input when enabled=%s", async (enabled) => {
      publishUploads(enabled);
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);
      const res = await postChatCompletions(getPort(), {
        model: "openclaw",
        messages: [{ role: "user", content: [imagePart] }],
      });
      expect(res.status, await res.text()).toBe(200);
      expect(firstAgentCommandOptions()?.images).toEqual([
        { type: "image", data: "QUJDRA==", mimeType: "image/png" },
      ]);
    });

    it.each([
      { name: "inline image", part: imagePart, stream: false },
      {
        name: "URL image in a streaming request",
        part: { type: "image_url", image_url: { url: "https://example.com/image.png" } },
        stream: true,
      },
      {
        name: "file",
        part: {
          type: "file",
          file: { filename: "notes.txt", file_data: "data:text/plain;base64,aGk=" },
        },
        stream: false,
      },
      {
        name: "malformed image before decoding",
        part: { type: "image_url", image_url: { url: "data:image/png;base64,%%%" } },
        stream: false,
      },
    ])("rejects $name without extraction or dispatch", async ({ part, stream }) => {
      publishUploads(false);
      const extraction = vi.spyOn(inputFiles, "extractImageContentFromSource");
      try {
        const res = await postChatCompletions(getPort(), {
          model: "openclaw",
          stream,
          messages: [{ role: "user", content: [{ type: "text", text: "Read this" }, part] }],
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: {
            type: "forbidden",
            code: "UPLOADS_DISABLED",
            message: "File and image uploads are disabled by gateway.uploads.enabled",
          },
        });
        expect(extraction).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        extraction.mockRestore();
      }
    });

    it("rejects a hot disable during command input admission", async () => {
      publishUploads(true);
      agentCommandMock.mockImplementationOnce(async (options) => {
        if (!isRecord(options) || typeof options.assertSourceCurrent !== "function") {
          throw new Error("Expected the HTTP command input admission guard");
        }
        publishUploads(false);
        await options.assertSourceCurrent();
        return { payloads: [], meta: { durationMs: 0 } };
      });
      const res = await postChatCompletions(getPort(), {
        model: "openclaw",
        messages: [{ role: "user", content: [imagePart] }],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { message: "File and image uploads are disabled by gateway.uploads.enabled" },
      });
    });

    it("rejects historical image content instead of accepting an attachment bypass", async () => {
      publishUploads(false);
      const res = await postChatCompletions(getPort(), {
        model: "openclaw",
        messages: [
          { role: "user", content: [imagePart] },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Follow up" },
        ],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "UPLOADS_DISABLED" } });
      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it("allows text-only requests and generated media when uploads are disabled", async () => {
      publishUploads(false);
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "Generated image", mediaUrl: "https://example.com/generated.png" }],
      } as never);
      const res = await postChatCompletions(getPort(), {
        model: "openclaw",
        messages: [{ role: "user", content: "Generate an image" }],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        choices: [{ message: { content: "Generated image" } }],
      });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
      "rechecks upload policy after image preparation (stream=%s)",
      async (stream) => {
        publishUploads(true);
        const extraction = vi
          .spyOn(inputFiles, "extractImageContentFromSource")
          .mockImplementationOnce(async () => {
            publishUploads(false);
            return { type: "image", data: "QUJDRA==", mimeType: "image/png" };
          });
        try {
          const res = await postChatCompletions(getPort(), {
            model: "openclaw",
            stream,
            messages: [{ role: "user", content: [imagePart] }],
          });
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ error: { code: "UPLOADS_DISABLED" } });
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          extraction.mockRestore();
        }
      },
    );
  });
}

export function registerOpenResponsesHttpUploadTests({
  getPort,
  postResponses,
  firstAgentOpts,
  agentCommandMock,
  fetchWithSsrFGuardMock,
}: OpenResponsesMediaSuite & { fetchWithSsrFGuardMock: Mock }): void {
  describe("gateway upload policy", () => {
    const imagePart = {
      type: "input_image",
      source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
    };
    const filePart = {
      type: "input_file",
      source: {
        type: "base64",
        media_type: "text/plain",
        data: "dXBsb2FkZWQgdGV4dA==",
        filename: "notes.txt",
      },
    };

    it.each([undefined, true])("allows image and file input when enabled=%s", async (enabled) => {
      publishUploads(enabled);
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);
      const res = await postResponses(getPort(), {
        model: "openclaw",
        input: [{ type: "message", role: "user", content: [imagePart, filePart] }],
      });
      expect(res.status, await res.text()).toBe(200);
      expect(firstAgentOpts().images).toEqual([
        { type: "image", data: "QUJDRA==", mimeType: "image/png" },
      ]);
      expect(firstAgentOpts().extraSystemPrompt).toContain("uploaded text");
    });

    it.each([
      { name: "inline image", part: imagePart, stream: false },
      { name: "inline file", part: filePart, stream: false },
      {
        name: "URL image in a streaming request",
        part: {
          type: "input_image",
          source: { type: "url", url: "https://example.com/image.png" },
        },
        stream: true,
      },
      {
        name: "URL file",
        part: { type: "input_file", source: { type: "url", url: "https://example.com/notes.txt" } },
        stream: false,
      },
      {
        name: "malformed base64 before decoding",
        part: { ...filePart, source: { ...filePart.source, data: "%%%" } },
        stream: false,
      },
    ])("rejects $name without extraction, fetching, or dispatch", async ({ part, stream }) => {
      publishUploads(false);
      const imageExtraction = vi.spyOn(inputFiles, "extractImageContentFromSource");
      const fileExtraction = vi.spyOn(inputFiles, "extractFileContentFromSource");
      try {
        const res = await postResponses(getPort(), {
          model: "openclaw",
          stream,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Read this" }, part],
            },
          ],
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: {
            type: "forbidden",
            code: "UPLOADS_DISABLED",
            message: "File and image uploads are disabled by gateway.uploads.enabled",
          },
        });
        expect(imageExtraction).not.toHaveBeenCalled();
        expect(fileExtraction).not.toHaveBeenCalled();
        expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        imageExtraction.mockRestore();
        fileExtraction.mockRestore();
      }
    });

    it("rejects historical file content instead of accepting an attachment bypass", async () => {
      publishUploads(false);
      const res = await postResponses(getPort(), {
        model: "openclaw",
        input: [
          { type: "message", role: "user", content: [filePart] },
          { type: "message", role: "user", content: "Follow up" },
        ],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "UPLOADS_DISABLED" } });
      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it("rejects a hot disable during command input admission", async () => {
      publishUploads(true);
      agentCommandMock.mockImplementationOnce(async (options) => {
        if (!isRecord(options) || typeof options.assertSourceCurrent !== "function") {
          throw new Error("Expected the HTTP command input admission guard");
        }
        publishUploads(false);
        await options.assertSourceCurrent();
        return { payloads: [], meta: { durationMs: 0 } };
      });
      const res = await postResponses(getPort(), {
        model: "openclaw",
        input: [{ type: "message", role: "user", content: [filePart] }],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { message: "File and image uploads are disabled by gateway.uploads.enabled" },
      });
    });

    it("allows text-only requests and generated media when uploads are disabled", async () => {
      publishUploads(false);
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "Generated image", mediaUrl: "https://example.com/generated.png" }],
      } as never);
      const res = await postResponses(getPort(), {
        model: "openclaw",
        input: "Generate an image",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        output: [{ content: [{ text: "Generated image" }] }],
      });
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
      "rechecks upload policy after file preparation (stream=%s)",
      async (stream) => {
        publishUploads(true);
        const extraction = vi
          .spyOn(inputFiles, "extractFileContentFromSource")
          .mockImplementationOnce(async () => {
            publishUploads(false);
            return { filename: "notes.txt", text: "uploaded text" };
          });
        try {
          const res = await postResponses(getPort(), {
            model: "openclaw",
            stream,
            input: [{ type: "message", role: "user", content: [filePart] }],
          });
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ error: { code: "UPLOADS_DISABLED" } });
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          extraction.mockRestore();
        }
      },
    );
  });
}

export async function runOpenAiHttpImageInputCases({
  port,
  postChatCompletions,
  mockAgentOnce,
  getFirstAgentCall,
  getFirstAgentMessage,
  expectInvalidRequestNoDispatch,
}: {
  port: number;
  postChatCompletions: PostRequest;
  mockAgentOnce: (payloads: Array<{ text: string }>) => void;
  getFirstAgentCall: OpenAiMediaSuite["firstAgentCommandOptions"];
  getFirstAgentMessage: () => string;
  expectInvalidRequestNoDispatch: (messages: unknown[]) => Promise<void>;
}): Promise<void> {
  {
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA";
    mockAgentOnce([{ text: "looks good" }]);
    const res = await postChatCompletions(port, {
      model: "openclaw",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${imageData}` },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    const firstCall = getFirstAgentCall();
    expect(firstCall?.message).toBe("describe this");
    expect(firstCall?.images).toEqual([{ type: "image", data: imageData, mimeType: "image/png" }]);
    await res.text();
  }

  {
    const imageData = "QUJDRA==";
    mockAgentOnce([{ text: "supports data-uri params" }]);
    const res = await postChatCompletions(port, {
      model: "openclaw",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "with metadata params" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;charset=utf-8;base64,${imageData}` },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    const firstCall = getFirstAgentCall();
    expect(firstCall?.images).toEqual([{ type: "image", data: imageData, mimeType: "image/png" }]);
    await res.text();
  }

  await expectInvalidRequestNoDispatch([
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "https://example.com/image.png" },
        },
      ],
    },
  ]);

  const malformedImageParts = [
    { type: "image_url" },
    { type: "image_url", image_url: null },
    { type: "image_url", image_url: {} },
    { type: "image_url", image_url: { url: "   " } },
    { type: "image_url", image_url: { url: 123 } },
    { type: "image_url", image_url: { url: null } },
    { type: "image_url", image_url: "   " },
    { type: "image_url", image_url: 123 },
  ];
  const validImagePart = {
    type: "image_url",
    image_url: { url: "data:image/png;base64,QUJDRA==" },
  };
  for (const imagePart of malformedImageParts) {
    for (const content of [
      [imagePart],
      [{ type: "text", text: "describe this" }, imagePart],
      [validImagePart, imagePart],
    ]) {
      await expectInvalidRequestNoDispatch([{ role: "user", content }]);
    }
  }

  for (const malformedDataUri of [
    "data:image/png,QUJDRA==",
    "data:image/png;base64,",
    "data:image/png;base64,%%%",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,JVBERi0xLjQK",
  ]) {
    await expectInvalidRequestNoDispatch([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: malformedDataUri } },
        ],
      },
    ]);
  }

  {
    mockAgentOnce([{ text: "I can see the image" }]);
    const res = await postChatCompletions(port, {
      model: "openclaw",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,QUJDRA==" },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    const firstCall = getFirstAgentCall();
    expect(firstCall?.message).toContain("User sent image(s) with no text.");
    expect(firstCall?.images).toEqual([
      { type: "image", data: "QUJDRA==", mimeType: "image/jpeg" },
    ]);
    await res.text();
  }

  {
    mockAgentOnce([{ text: "follow up answer" }]);
    const res = await postChatCompletions(port, {
      model: "openclaw",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } }],
        },
        { role: "assistant", content: "I can see it." },
        { role: "user", content: "What color was it?" },
      ],
    });
    expect(res.status).toBe(200);

    const firstCall = getFirstAgentCall();
    expect(firstCall?.images).toBeUndefined();
    expect(firstCall?.message ?? "").not.toContain("User sent image(s) with no text.");
    await res.text();
  }

  for (const historicalImageParts of [
    [{ type: "image_url", image_url: { url: "   " } }],
    [validImagePart, { type: "image_url", image_url: { url: "   " } }],
  ]) {
    for (const followup of [
      { role: "user", content: "What color was it?" },
      { role: "tool", content: "Vision tool says it is blue." },
    ]) {
      mockAgentOnce([{ text: "follow up answer" }]);
      const res = await postChatCompletions(port, {
        model: "openclaw",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "look at this" }, ...historicalImageParts],
          },
          { role: "assistant", content: "Checking the image." },
          followup,
        ],
      });
      expect(res.status).toBe(200);
      expect(getFirstAgentCall()?.images).toBeUndefined();
      expect(getFirstAgentMessage()).toContain("User: look at this");
      await res.text();
    }
  }

  {
    mockAgentOnce([{ text: "latest image only" }]);
    const res = await postChatCompletions(port, {
      model: "openclaw",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUFBQQ==" } },
          ],
        },
        { role: "assistant", content: "noted" },
        {
          role: "user",
          content: [
            { type: "text", text: "second" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QkJCQg==" } },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    const firstCall = getFirstAgentCall();
    expect(firstCall?.images).toEqual([{ type: "image", data: "QkJCQg==", mimeType: "image/png" }]);
    await res.text();
  }
}

export function registerOpenResponsesHttpMediaInputTests({
  getPort,
  postResponses,
  firstAgentOpts,
  agentCommandMock,
  mockAgentOnce,
  ensureResponseConsumed,
  expectInvalidRequest,
  buildUrlInputMessage,
  buildFileInputMessage,
}: OpenResponsesMediaSuite & {
  mockAgentOnce: (payloads: Array<{ text: string }>) => void;
  buildFileInputMessage: (text: string, filename: string, message?: string) => unknown;
  ensureResponseConsumed: (res: Response) => Promise<void>;
  expectInvalidRequest: (res: Response, pattern: RegExp) => Promise<unknown>;
  buildUrlInputMessage: (params: {
    kind: "input_file" | "input_image";
    url: string;
    text?: string;
  }) => unknown;
}): void {
  it("blocks unsafe URL-based file/image inputs", async () => {
    const port = getPort();
    agentCommandMock.mockClear();

    const blockedPrivate = await postResponses(port, {
      model: "openclaw",
      input: buildUrlInputMessage({
        kind: "input_file",
        url: "http://127.0.0.1:6379/info",
      }),
    });
    await expectInvalidRequest(blockedPrivate, /invalid request|private|internal|blocked/i);

    const blockedMetadata = await postResponses(port, {
      model: "openclaw",
      input: buildUrlInputMessage({
        kind: "input_image",
        url: "http://metadata.google.internal/computeMetadata/v1",
      }),
    });
    await expectInvalidRequest(blockedMetadata, /invalid request|blocked|metadata|internal/i);

    const blockedScheme = await postResponses(port, {
      model: "openclaw",
      input: buildUrlInputMessage({
        kind: "input_file",
        url: "file:///etc/passwd",
      }),
    });
    await expectInvalidRequest(blockedScheme, /invalid request|http or https/i);
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("accepts image-only input without text, matching /v1/chat/completions", async () => {
    const port = getPort();
    // 1x1 PNG; same fixture used by the parity schema tests.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    mockAgentOnce([{ text: "ok" }]);

    const res = await postResponses(port, {
      model: "openclaw",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              source: { type: "base64", media_type: "image/png", data: pngBase64 },
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = firstAgentOpts();
    // Image-only turn carries a non-empty placeholder so the agent command runs,
    // with the real image attached via `images` (parity with /v1/chat/completions).
    expect((opts as { message?: string }).message ?? "").toBe(IMAGE_ONLY_USER_MESSAGE);
    expect((opts as { images?: unknown[] }).images?.length).toBe(1);
    await ensureResponseConsumed(res);
  });

  it("accepts file-only input without text, matching image-only", async () => {
    const port = getPort();
    mockAgentOnce([{ text: "ok" }]);

    const res = await postResponses(port, {
      model: "openclaw",
      instructions: "Summarize the attached document.",
      input: buildFileInputMessage("the quick brown fox", "doc.txt"),
    });

    expect(res.status).toBe(200);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = firstAgentOpts();
    expect((opts as { message?: string }).message ?? "").not.toBe("");
    const extraSystemPrompt = (opts as { extraSystemPrompt?: string }).extraSystemPrompt ?? "";
    expect(extraSystemPrompt).toContain('<file name="doc.txt">');
    expect(extraSystemPrompt).toContain("the quick brown fox");
    await ensureResponseConsumed(res);
  });

  it("keeps base64 input_file text truncation UTF-16 safe", async () => {
    const port = getPort();
    const text = `${"a".repeat(59_999)}😀tail`;
    mockAgentOnce([{ text: "ok" }]);

    const res = await postResponses(port, {
      model: "openclaw",
      input: buildFileInputMessage(text, "emoji-boundary.txt"),
    });

    expect(res.status).toBe(200);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = firstAgentOpts();
    const extraSystemPrompt = (opts as { extraSystemPrompt?: string }).extraSystemPrompt ?? "";
    expect(extraSystemPrompt).toContain('<file name="emoji-boundary.txt">');
    expect(extraSystemPrompt).toContain("a".repeat(59_999));
    expect(extraSystemPrompt).not.toContain("😀");
    expect(extraSystemPrompt).not.toMatch(/[\uD800-\uDFFF]/u);
    await ensureResponseConsumed(res);
  });

  it("still rejects input with neither text nor image", async () => {
    const port = getPort();
    agentCommandMock.mockClear();

    const res = await postResponses(port, {
      model: "openclaw",
      input: [{ type: "message", role: "user", content: [] }],
    });

    await expectInvalidRequest(res, /Missing user message/i);
    expect(agentCommandMock).not.toHaveBeenCalled();
  });
}
