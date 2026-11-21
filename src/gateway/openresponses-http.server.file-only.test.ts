import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const extractFileContentFromSourceMock = vi.fn();

vi.mock("../media/input-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../media/input-files.js")>("../media/input-files.js");
  return {
    ...actual,
    extractFileContentFromSource: (...args: unknown[]) => extractFileContentFromSourceMock(...args),
  };
});

import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startGatewayServerWithRetries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const PNG_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let server: Awaited<ReturnType<typeof startGatewayServerWithRetries>>["server"];
let port: number;

beforeAll(async () => {
  const started = await startGatewayServerWithRetries({
    port: await getGatewayTestPort(),
    opts: {
      host: "127.0.0.1",
      auth: { mode: "none" },
      controlUiEnabled: false,
      openResponsesEnabled: true,
    },
  });
  port = started.port;
  server = started.server;
});

afterAll(async () => {
  await server?.close({ reason: "openresponses file-only suite done" });
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function postInput(input: unknown, instructions?: string) {
  agentCommandMock.mockResolvedValueOnce({
    payloads: [{ text: "ok", mediaUrl: null }],
    meta: { durationMs: 0 },
  });
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-scopes": "operator.write",
    },
    body: JSON.stringify({ model: "openclaw", input, instructions }),
  });
  expect(res.status, await res.text()).toBe(200);
  expect(agentCommandMock).toHaveBeenCalledTimes(1);
  return agentCommandMock.mock.calls[0]?.[0] as {
    message?: string;
    images?: unknown[];
    extraSystemPrompt?: string;
  };
}

function message(content: unknown) {
  return { type: "message", role: "user", content };
}

function createInputImage() {
  return {
    type: "input_image",
    source: { type: "base64", media_type: "image/png", data: PNG_IMAGE_BASE64 },
  } as const;
}

function createInputFile(filename: string) {
  return {
    type: "input_file",
    source: {
      type: "base64",
      media_type: "text/plain",
      data: Buffer.from(`contents of ${filename}`).toString("base64"),
      filename,
    },
  } as const;
}

describe("OpenResponses file-only input that renders to images", () => {
  it("keeps extraction truncation visible outside uploaded file content", async () => {
    extractFileContentFromSourceMock.mockResolvedValueOnce({
      filename: "partial.pdf",
      text: "visible prefix",
      images: [],
      metadata: {
        pages: { total: 21, processed: [1, 2, 3], selection: "automatic", truncated: true },
        textTruncated: false,
        imagesTruncated: false,
      },
    });
    const opts = await postInput([message([createInputFile("partial.pdf")])]);
    expect(opts.extraSystemPrompt).toContain("[Partial document: 3 of 21 pages processed.]");
    expect(opts.extraSystemPrompt).toMatch(
      /\[Partial document[^]*<<<EXTERNAL_UNTRUSTED_CONTENT[^]*visible prefix/,
    );
  });

  it("accepts a file-only turn whose file renders to images and forwards them", async () => {
    extractFileContentFromSourceMock.mockResolvedValueOnce({
      filename: "scan.pdf",
      text: "",
      images: [
        { type: "image", data: Buffer.alloc(8, 1).toString("base64"), mimeType: "image/png" },
      ],
    });
    const opts = await postInput(
      [
        message([
          {
            type: "input_file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from("%PDF-1.4 scanned").toString("base64"),
              filename: "scan.pdf",
            },
          },
        ]),
      ],
      "Describe the attached scan.",
    );
    expect(opts.message ?? "").not.toBe("");
    expect(opts.images).toHaveLength(1);
  });

  it("does not replay historical attachments after a terminal client-tool result", async () => {
    const opts = await postInput([
      message([createInputImage(), createInputFile("historical.txt")]),
      { type: "message", role: "assistant", content: "I inspected the attachments." },
      {
        type: "function_call_output",
        call_id: "call_lookup",
        output: "The previous answer was accepted.",
      },
    ]);
    expect(extractFileContentFromSourceMock).not.toHaveBeenCalled();
    expect(opts.message).toContain("The previous answer was accepted.");
    expect(opts.message).not.toContain("User sent image(s) with no text.");
    expect(opts.images).toBeUndefined();
    expect(opts.extraSystemPrompt ?? "").not.toContain("historical.txt");
  });

  it("extracts attachments only from the latest active user message", async () => {
    extractFileContentFromSourceMock.mockImplementation(
      async ({ source }: { source: { filename?: string } }) => ({
        filename: source.filename,
        text: `contents of ${source.filename}`,
        images: [],
      }),
    );
    const opts = await postInput([
      message([
        { type: "input_text", text: "Inspect the first attachments." },
        createInputImage(),
        createInputFile("historical.txt"),
      ]),
      { type: "message", role: "assistant", content: "The first attachments were inspected." },
      message([
        { type: "input_text", text: "Inspect only the current attachments." },
        createInputImage(),
        createInputFile("current.txt"),
      ]),
    ]);
    expect(extractFileContentFromSourceMock).toHaveBeenCalledTimes(1);
    expect(opts.images).toHaveLength(1);
    expect(opts.extraSystemPrompt).toContain("current.txt");
    expect(opts.extraSystemPrompt).not.toContain("historical.txt");
  });

  it("counts historical image and file URLs against the request-wide source limit", async () => {
    const parts = Array.from({ length: 9 }, (_, index) => ({
      type: index % 2 === 0 ? "input_image" : "input_file",
      source: { type: "url", url: `https://example.com/historical-${index}` },
    }));
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openclaw-scopes": "operator.write" },
      body: JSON.stringify({
        model: "openclaw",
        input: [message(parts), message("Answer without fetching history.")],
      }),
    });
    expect(res.status).toBe(400);
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(extractFileContentFromSourceMock).not.toHaveBeenCalled();
    await res.text();
  });
});
