import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { prepareAttachment } from "../media/attachment-processor.runtime.js";
import * as inputFiles from "../media/input-files.js";
import { renderInboundDocumentContext } from "./file-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("renderInboundDocumentContext", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["success", "failure"] as const)(
    "propagates cancellation after extraction %s without rendering or reading the next file",
    async (outcome) => {
      const workspaceDir = tempDirs.make("openclaw-document-abort-");
      const firstPath = path.join(workspaceDir, "first.txt");
      const secondPath = path.join(workspaceDir, "second.txt");
      await fs.writeFile(firstPath, "first document");
      await fs.writeFile(secondPath, "second document");
      const controller = new AbortController();
      const reason = new Error("reply stopped");
      let extractionSignal: AbortSignal | undefined;
      const extract = vi
        .spyOn(inputFiles, "extractFileContentFromBuffer")
        .mockImplementationOnce(async (params) => {
          extractionSignal = params.signal;
          controller.abort(reason);
          if (outcome === "failure") {
            throw reason;
          }
          return { text: "late extracted text", filename: params.filename ?? "first.txt" };
        });
      const ctx: MsgContext = { media: [{ path: firstPath }, { path: secondPath }] };

      await expect(
        renderInboundDocumentContext({
          ctx,
          cfg: {},
          workspaceDir,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);

      expect(extractionSignal).toBe(controller.signal);
      expect(extract).toHaveBeenCalledOnce();
    },
  );

  it("stops a canceled document read before extracting or advancing to another attachment", async () => {
    const workspaceDir = tempDirs.make("openclaw-document-read-abort-");
    const firstPath = path.join(workspaceDir, "first.txt");
    const secondPath = path.join(workspaceDir, "second.txt");
    await fs.writeFile(firstPath, "first document");
    await fs.writeFile(secondPath, "second document");
    const controller = new AbortController();
    const reason = new Error("reply stopped");
    const extract = vi.spyOn(inputFiles, "extractFileContentFromBuffer");
    const open = fs.open.bind(fs);
    const openedPaths: unknown[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      openedPaths.push(args[0]);
      const handle = await open(...args);
      controller.abort(reason);
      return handle;
    });

    await expect(
      renderInboundDocumentContext({
        ctx: { media: [{ path: firstPath }, { path: secondPath }] },
        cfg: {},
        workspaceDir,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);

    expect(openedPaths).toHaveLength(1);
    expect(extract).not.toHaveBeenCalled();
  });

  it.each(["", "application/octet-stream"])(
    "retains inferred legacy encoding through prepared content type %j",
    async (mime) => {
      const workspaceDir = tempDirs.make("openclaw-prepared-document-");
      const mediaPath = path.join(workspaceDir, "notes.txt");
      const text = "Café notes: résumé et météo pour demain.";
      const buffer = Buffer.from(text, "latin1");
      const prepared = await prepareAttachment({
        base64: buffer.toString("base64"),
        label: "notes.txt",
        mime,
      });
      await fs.writeFile(mediaPath, buffer);
      const ctx: MsgContext = {
        media: [{ path: mediaPath, contentType: prepared.mime, fileName: "notes.txt" }],
      };

      const context = await renderInboundDocumentContext({ ctx, cfg: {}, workspaceDir });

      expect(prepared.mime).toBe("text/plain; charset=windows-1252");
      expect(context.text).toContain(text);
      expect(context.text).not.toContain("\uFFFD");
    },
  );

  it.each([
    { encoding: "utf8", mime: "", expectedMime: "text/plain" },
    { encoding: "latin1", mime: "text/plain", expectedMime: "text/plain" },
    { encoding: "latin1", mime: "text/plain; charset=utf-8", expectedMime: "text/plain" },
  ] as const)("keeps existing prepared MIME for $encoding with $mime", async (input) => {
    const prepared = await prepareAttachment({
      base64: Buffer.from("Café notes: résumé et météo pour demain.", input.encoding).toString(
        "base64",
      ),
      label: "notes.txt",
      mime: input.mime,
    });

    expect(prepared.mime).toBe(input.expectedMime);
  });

  it.each([
    {
      text: "document body for the steered run",
      maxChars: undefined,
      expected: "document body for the steered run",
      truncated: false,
    },
    {
      text: "document body for the steered run",
      maxChars: 13,
      expected: "document body",
      truncated: true,
    },
    { text: "雪🙂", maxChars: 4, expected: "雪🙂", truncated: false },
    { text: "雪🙂!", maxChars: 4, expected: "雪🙂!", truncated: false },
    { text: "雪🙂!tail", maxChars: 4, expected: "雪🙂!", truncated: true },
    { text: "雪🙂tail", maxChars: 2, expected: "雪", truncated: true },
    { text: "not empty", maxChars: 0, expected: "", truncated: true },
  ])(
    "renders actual attachment text without mutating input at limit $maxChars for $text",
    async ({ text, maxChars, expected, truncated }) => {
      const workspaceDir = tempDirs.make("openclaw-document-context-");
      const mediaPath = path.join(workspaceDir, "steer-note.txt");
      await fs.writeFile(mediaPath, text);
      const ctx: MsgContext = {
        Body: "see attached",
        media: [{ path: mediaPath, contentType: "text/plain" }],
      };
      const original = structuredClone(ctx);

      const context = await renderInboundDocumentContext({ ctx, cfg: {}, workspaceDir, maxChars });

      expect(context.text).toContain('<file name="steer-note.txt" mime="text/plain">');
      expect(context.text).toContain(`\n---\n${expected}\n`);
      expect(context.text).not.toContain("[No extractable text]");
      expect(context.text).not.toContain("\uFFFD");
      if (!truncated) {
        expect(context.text).not.toContain("[Partial document:");
      } else {
        expect(context.text).toContain("[Partial document: text truncated.]");
        expect(context.text).not.toContain("for the steered run");
        expect(context.text.indexOf("[Partial document:")).toBeLessThan(
          context.text.indexOf("<<<EXTERNAL_UNTRUSTED_CONTENT"),
        );
      }
      expect(context.images).toEqual([]);
      // Rejected steering must leave the original input available for normal dispatch.
      expect(ctx).toEqual(original);
    },
  );
});
