import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi, type Mock } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import * as inputFiles from "../media/input-files.js";
import { IMAGE_ONLY_USER_MESSAGE } from "./agent-prompt.js";
import type { agentCommandMock as sharedAgentCommandMock } from "./test-helpers.runtime-state.js";

type PostRequest = (port: number, body: unknown) => Promise<Response>;

const chatMessage = (content: unknown, role = "user") => ({ role, content });
const responseMessage = (content: unknown) => ({ type: "message", role: "user", content });
const chatImage = (url = "data:image/png;base64,QUJDRA==") => ({
  type: "image_url",
  image_url: { url },
});
const textPart = (text: string) => ({ type: "text", text });
const withChatImage = (text: string, url: string) => chatMessage([textPart(text), chatImage(url)]);
const responseBase64 = (
  type: "input_file" | "input_image",
  media_type: string,
  data: string,
  filename?: string,
) => ({
  type,
  source: { type: "base64", media_type, data, ...(filename ? { filename } : {}) },
});
const uploadsDisabledError = {
  type: "forbidden",
  code: "UPLOADS_DISABLED",
  message: "File and image uploads are disabled by gateway.uploads.enabled",
};

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

function disableUploadsDuringAdmission(agentCommandMock: HttpMediaSuite["agentCommandMock"]) {
  publishUploads(true);
  agentCommandMock.mockImplementationOnce(async (options) => {
    if (!isRecord(options) || typeof options.assertSourceCurrent !== "function") {
      throw new Error("Expected the HTTP command input admission guard");
    }
    publishUploads(false);
    options.assertSourceCurrent();
    return { payloads: [], meta: { durationMs: 0, terminalReply: { disposition: "empty" } } };
  });
}

type ResponsesUploadSuite = OpenResponsesMediaSuite & { fetchWithSsrFGuardMock: Mock };

export function registerOpenAiHttpUploadTests(suite: OpenAiMediaSuite): void {
  registerUploadPolicyTests(suite);
}

export function registerOpenResponsesHttpUploadTests(suite: ResponsesUploadSuite): void {
  registerUploadPolicyTests(suite);
}

function registerUploadPolicyTests(suite: OpenAiMediaSuite | ResponsesUploadSuite): void {
  const responses = "postResponses" in suite;
  const { agentCommandMock, getPort } = suite;
  const message = responses ? responseMessage : chatMessage;
  const post = (input: unknown, stream?: boolean) =>
    "postResponses" in suite
      ? suite.postResponses(getPort(), { model: "openclaw", input, stream })
      : suite.postChatCompletions(getPort(), { model: "openclaw", messages: input, stream });
  const imagePart = responses
    ? responseBase64("input_image", "image/png", "QUJDRA==")
    : chatImage();
  const responseFile = (data = "dXBsb2FkZWQgdGV4dA==") =>
    responseBase64("input_file", "text/plain", data, "notes.txt");
  const responseUrl = (type: "input_file" | "input_image", url: string) => ({
    type,
    source: { type: "url", url },
  });
  const filePart = responses
    ? responseFile()
    : { type: "file", file: { filename: "notes.txt", file_data: "data:text/plain;base64,aGk=" } };
  const upload = responses ? filePart : imagePart;

  describe("gateway upload policy", () => {
    it.each([undefined, true])("allows media input when enabled=%s", async (enabled) => {
      publishUploads(enabled);
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "ok" }] } as never);
      const res = await post([message(responses ? [imagePart, filePart] : [imagePart])]);
      expect(res.status, await res.text()).toBe(200);
      const opts =
        "firstAgentOpts" in suite ? suite.firstAgentOpts() : suite.firstAgentCommandOptions();
      expect(opts?.images).toEqual([{ type: "image", data: "QUJDRA==", mimeType: "image/png" }]);
      if ("firstAgentOpts" in suite) {
        expect(suite.firstAgentOpts().extraSystemPrompt).toContain("uploaded text");
      }
    });

    const blockedCase = (name: string, part: unknown, stream = false) => ({ name, part, stream });
    const blocked = responses
      ? [
          blockedCase("inline image", imagePart),
          blockedCase("inline file", filePart),
          blockedCase(
            "URL image in a streaming request",
            responseUrl("input_image", "https://example.com/image.png"),
            true,
          ),
          blockedCase("URL file", responseUrl("input_file", "https://example.com/notes.txt")),
          blockedCase("malformed base64 before decoding", responseFile("%%%")),
        ]
      : [
          blockedCase("inline image", imagePart),
          blockedCase(
            "URL image in a streaming request",
            chatImage("https://example.com/image.png"),
            true,
          ),
          blockedCase("file", filePart),
          blockedCase("malformed image before decoding", chatImage("data:image/png;base64,%%%")),
        ];
    it.each(blocked)("rejects $name without extraction or dispatch", async ({ part, stream }) => {
      publishUploads(false);
      const imageExtraction = vi.spyOn(inputFiles, "extractImageContentFromSource");
      const fileExtraction = responses
        ? vi.spyOn(inputFiles, "extractFileContentFromSource")
        : undefined;
      try {
        const res = await post(
          [message([{ type: responses ? "input_text" : "text", text: "Read this" }, part])],
          stream,
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: uploadsDisabledError });
        expect(imageExtraction).not.toHaveBeenCalled();
        if (fileExtraction) {
          expect(fileExtraction).not.toHaveBeenCalled();
        }
        if ("fetchWithSsrFGuardMock" in suite) {
          expect(suite.fetchWithSsrFGuardMock).not.toHaveBeenCalled();
        }
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        imageExtraction.mockRestore();
        fileExtraction?.mockRestore();
      }
    });

    it("rejects a hot disable during command input admission", async () => {
      disableUploadsDuringAdmission(agentCommandMock);
      const res = await post([message([upload])]);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { message: uploadsDisabledError.message } });
    });

    it("rejects historical uploads instead of accepting an attachment bypass", async () => {
      publishUploads(false);
      const history = responses
        ? [responseMessage([filePart]), responseMessage("Follow up")]
        : [
            chatMessage([imagePart]),
            chatMessage("Earlier answer", "assistant"),
            chatMessage("Follow up"),
          ];
      const res = await post(history);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "UPLOADS_DISABLED" } });
      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it("allows text-only requests and generated media when uploads are disabled", async () => {
      publishUploads(false);
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "Generated image", mediaUrl: "https://example.com/generated.png" }],
      } as never);
      const res = await post(responses ? "Generate an image" : [chatMessage("Generate an image")]);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject(
        responses
          ? { output: [{ content: [{ text: "Generated image" }] }] }
          : { choices: [{ message: { content: "Generated image" } }] },
      );
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
      "rechecks upload policy after preparation (stream=%s)",
      async (stream) => {
        publishUploads(true);
        const extraction = responses
          ? vi
              .spyOn(inputFiles, "extractFileContentFromSource")
              .mockImplementationOnce(async () => {
                publishUploads(false);
                return { filename: "notes.txt", text: "uploaded text" };
              })
          : vi
              .spyOn(inputFiles, "extractImageContentFromSource")
              .mockImplementationOnce(async () => {
                publishUploads(false);
                return { type: "image", data: "QUJDRA==", mimeType: "image/png" };
              });
        try {
          const res = await post([message([upload])], stream);
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
  const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });
  async function accept(
    messages: unknown[],
    images: Array<ReturnType<typeof image>> | undefined,
    checkMessage?: (message: string | undefined) => void,
  ) {
    mockAgentOnce([{ text: "ok" }]);
    const res = await postChatCompletions(port, { model: "openclaw", messages });
    expect(res.status).toBe(200);
    const call = getFirstAgentCall();
    expect(call?.images).toEqual(images);
    checkMessage?.(call?.message);
    await res.text();
  }

  const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA";
  await accept(
    [withChatImage("describe this", `data:image/png;base64,${pngData}`)],
    [image(pngData)],
    (message) => expect(message).toBe("describe this"),
  );
  await accept(
    [withChatImage("with metadata params", "data:image/png;charset=utf-8;base64,QUJDRA==")],
    [image("QUJDRA==")],
  );

  await expectInvalidRequestNoDispatch([chatMessage([chatImage("https://example.com/image.png")])]);
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
  const validImagePart = chatImage();
  for (const imagePart of malformedImageParts) {
    for (const content of [
      [imagePart],
      [textPart("describe this"), imagePart],
      [validImagePart, imagePart],
    ]) {
      await expectInvalidRequestNoDispatch([chatMessage(content)]);
    }
  }
  for (const uri of [
    "data:image/png,QUJDRA==",
    "data:image/png;base64,",
    "data:image/png;base64,%%%",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,JVBERi0xLjQK",
  ]) {
    await expectInvalidRequestNoDispatch([withChatImage("describe this", uri)]);
  }

  await accept(
    [chatMessage([chatImage("data:image/jpeg;base64,QUJDRA==")])],
    [image("QUJDRA==", "image/jpeg")],
    (message) => expect(message).toContain("User sent image(s) with no text."),
  );
  await accept(
    [
      chatMessage([chatImage()]),
      chatMessage("I can see it.", "assistant"),
      chatMessage("What color was it?"),
    ],
    undefined,
    (message) => expect(message ?? "").not.toContain("User sent image(s) with no text."),
  );
  for (const historicalImageParts of [[chatImage("   ")], [validImagePart, chatImage("   ")]]) {
    for (const followup of [
      chatMessage("What color was it?"),
      chatMessage("Vision tool says it is blue.", "tool"),
    ]) {
      await accept(
        [
          chatMessage([textPart("look at this"), ...historicalImageParts]),
          chatMessage("Checking the image.", "assistant"),
          followup,
        ],
        undefined,
        () => expect(getFirstAgentMessage()).toContain("User: look at this"),
      );
    }
  }
  await accept(
    [
      withChatImage("first", "data:image/png;base64,QUFBQQ=="),
      chatMessage("noted", "assistant"),
      withChatImage("second", "data:image/png;base64,QkJCQg=="),
    ],
    [image("QkJCQg==")],
  );
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
  const post = (input: unknown, extra = {}) =>
    postResponses(getPort(), { model: "openclaw", input, ...extra });
  async function accept(
    input: unknown,
    check: (options: Record<string, unknown>) => void,
    extra = {},
  ) {
    mockAgentOnce([{ text: "ok" }]);
    const res = await post(input, extra);
    expect(res.status).toBe(200);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    check(firstAgentOpts());
    await ensureResponseConsumed(res);
  }
  it("blocks unsafe URL-based file/image inputs", async () => {
    agentCommandMock.mockClear();
    for (const [kind, url, error] of [
      ["input_file", "http://127.0.0.1:6379/info", /invalid request|private|internal|blocked/i],
      [
        "input_image",
        "http://metadata.google.internal/computeMetadata/v1",
        /invalid request|blocked|metadata|internal/i,
      ],
      ["input_file", "file:///etc/passwd", /invalid request|http or https/i],
    ] as const) {
      await expectInvalidRequest(await post(buildUrlInputMessage({ kind, url })), error);
    }
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("accepts image-only input without text, matching /v1/chat/completions", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    await accept(
      [responseMessage([responseBase64("input_image", "image/png", pngBase64)])],
      (opts) => {
        expect(opts.message ?? "").toBe(IMAGE_ONLY_USER_MESSAGE);
        expect(opts.images).toHaveLength(1);
      },
    );
  });

  it("accepts file-only input without text, matching image-only", async () => {
    await accept(
      buildFileInputMessage("the quick brown fox", "doc.txt"),
      (opts) => {
        expect(opts.message ?? "").not.toBe("");
        const extraSystemPrompt = opts.extraSystemPrompt ?? "";
        expect(extraSystemPrompt).toContain('<file name="doc.txt">');
        expect(extraSystemPrompt).toContain("the quick brown fox");
      },
      { instructions: "Summarize the attached document." },
    );
  });

  it("keeps base64 input_file text truncation UTF-16 safe", async () => {
    const text = `${"a".repeat(59_999)}😀tail`;
    await accept(buildFileInputMessage(text, "emoji-boundary.txt"), (opts) => {
      const extraSystemPrompt = opts.extraSystemPrompt ?? "";
      expect(extraSystemPrompt).toContain('<file name="emoji-boundary.txt">');
      expect(extraSystemPrompt).toContain("a".repeat(59_999));
      expect(extraSystemPrompt).not.toContain("😀");
      expect(extraSystemPrompt).not.toMatch(/[\uD800-\uDFFF]/u);
    });
  });

  it("still rejects input with neither text nor image", async () => {
    agentCommandMock.mockClear();

    const res = await post([responseMessage([])]);

    await expectInvalidRequest(res, /Missing user message/i);
    expect(agentCommandMock).not.toHaveBeenCalled();
  });
}
