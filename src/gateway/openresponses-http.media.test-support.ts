import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as inputFiles from "../media/input-files.js";
import { agentCommandMock } from "./test-helpers.js";

export function registerOpenResponsesFileInputTests(
  post: (body: Record<string, unknown>) => Promise<Response>,
) {
  describe("OpenResponses file-only input that renders to images", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.spyOn(inputFiles, "extractFileContentFromSource").mockRejectedValue(
        new Error("unexpected file extraction"),
      );
    });
    afterEach(() => vi.mocked(inputFiles.extractFileContentFromSource).mockRestore());
    const PNG_IMAGE_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    async function postInput(input: unknown, instructions?: string) {
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "ok", mediaUrl: null }],
        meta: { durationMs: 0 },
      });
      const res = await post({ input, instructions });
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

    function createInputFile(
      filename: string,
      text = `contents of ${filename}`,
      mediaType = "text/plain",
    ) {
      return {
        type: "input_file",
        source: {
          type: "base64",
          media_type: mediaType,
          data: Buffer.from(text).toString("base64"),
          filename,
        },
      } as const;
    }

    it("keeps extraction truncation visible outside uploaded file content", async () => {
      vi.mocked(inputFiles.extractFileContentFromSource).mockResolvedValueOnce({
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
      vi.mocked(inputFiles.extractFileContentFromSource).mockResolvedValueOnce({
        filename: "scan.pdf",
        text: "",
        images: [
          { type: "image", data: Buffer.alloc(8, 1).toString("base64"), mimeType: "image/png" },
        ],
      });
      const opts = await postInput(
        [message([createInputFile("scan.pdf", "%PDF-1.4 scanned", "application/pdf")])],
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
      expect(vi.mocked(inputFiles.extractFileContentFromSource)).not.toHaveBeenCalled();
      expect(opts.message).toContain("The previous answer was accepted.");
      expect(opts.message).not.toContain("User sent image(s) with no text.");
      expect(opts.images).toBeUndefined();
      expect(opts.extraSystemPrompt ?? "").not.toContain("historical.txt");
    });

    it("extracts attachments only from the latest active user message", async () => {
      vi.mocked(inputFiles.extractFileContentFromSource).mockImplementation(async ({ source }) => ({
        filename: source.filename ?? "file",
        text: `contents of ${source.filename}`,
        images: [],
      }));
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
      expect(vi.mocked(inputFiles.extractFileContentFromSource)).toHaveBeenCalledTimes(1);
      expect(opts.images).toHaveLength(1);
      expect(opts.extraSystemPrompt).toContain("current.txt");
      expect(opts.extraSystemPrompt).not.toContain("historical.txt");
    });

    it("counts historical image and file URLs against the request-wide source limit", async () => {
      const parts = Array.from({ length: 9 }, (_, index) => ({
        type: index % 2 === 0 ? "input_image" : "input_file",
        source: { type: "url", url: `https://example.com/historical-${index}` },
      }));
      const res = await post({
        input: [message(parts), message("Answer without fetching history.")],
      });
      expect(res.status).toBe(400);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(vi.mocked(inputFiles.extractFileContentFromSource)).not.toHaveBeenCalled();
      await res.text();
    });
  });
}
