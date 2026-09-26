import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { renderInboundDocumentContext } from "./file-context.js";

const extract = vi.hoisted(() => vi.fn());
vi.mock("../media/input-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/input-files.js")>()),
  extractFileContentFromBuffer: extract,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => extract.mockReset());

describe("retained document image outcomes", () => {
  it.each([false, true])(
    "preserves PDF page images after text budget exhaustion=%s",
    async (exhausted) => {
      const workspaceDir = tempDirs.make("openclaw-file-context-");
      const pdf = path.join(workspaceDir, "scan.pdf");
      const text = path.join(workspaceDir, "before.txt");
      await fs.writeFile(pdf, "%PDF-1.4\n");
      await fs.writeFile(text, "full");
      if (exhausted) {
        extract.mockResolvedValueOnce({ text: "full", images: [] });
      }
      const pages = [1, 2].map((page) => ({
        type: "image",
        data: "page-" + page,
        mimeType: "image/png",
      }));
      extract.mockResolvedValueOnce({ text: "", images: pages });
      const ctx = {
        Body: "see attached",
        media: [
          ...(exhausted ? [{ path: text, contentType: "text/plain" }] : []),
          { path: pdf, contentType: "application/pdf" },
        ],
      };
      const result = await renderInboundDocumentContext({
        ctx,
        cfg: {},
        workspaceDir,
        ...(exhausted ? { maxChars: 4 } : {}),
      });
      expect(result.text).toContain("[PDF content rendered to images]");
      expect(result.images).toEqual(
        pages.map((page) => Object.assign({}, page, { attachmentIndex: exhausted ? 1 : 0 })),
      );
      expect(ctx.Body).toBe("see attached");
    },
  );
});
