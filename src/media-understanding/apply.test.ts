import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
    if (auth?.apiKey) {
      return auth.apiKey;
    }
    throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
  },
}));

vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

async function loadApply() {
  return await import("./apply.js");
}

// Minimal valid PDF that pdfjs-dist can parse (1 blank page, no text)
const MINIMAL_PDF = [
  "%PDF-1.0",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj",
  "xref",
  "0 4",
  "0000000000 65535 f ",
  "0000000009 00000 n ",
  "0000000058 00000 n ",
  "0000000115 00000 n ",
  "trailer<</Size 4/Root 1 0 R>>",
  "startxref",
  "190",
  "%%EOF",
].join("\n");

/**
 * Build a minimal valid PDF with a text stream so pdfjs-dist can extract it.
 * The text content is embedded via a BT/ET block with a Tf + Tj operator.
 */
function buildPdfWithText(text: string): string {
  const stream = `BT /F1 12 Tf (${text}) Tj ET`;
  const streamLen = Buffer.byteLength(stream, "ascii");
  // Objects must be laid out sequentially; we track byte offsets for the xref.
  const lines: string[] = [];
  const offsets: number[] = [];
  function push(line: string) {
    offsets.push(Buffer.byteLength(lines.join("\n") + (lines.length > 0 ? "\n" : ""), "ascii"));
    lines.push(line);
  }
  // Header (not an object — offset 0 is reserved for the free entry)
  lines.push("%PDF-1.0");
  // 1: Catalog
  push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj");
  // 2: Pages
  push("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj");
  // 3: Page with font + contents ref
  push(
    "3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj",
  );
  // 4: Font (Type1 Helvetica — built-in, no embedding needed)
  push("4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj");
  // 5: Content stream
  push(`5 0 obj<</Length ${streamLen}>>\nstream\n${stream}\nendstream\nendobj`);

  const body = lines.join("\n");
  const xrefOffset = Buffer.byteLength(body + "\n", "ascii");
  const xref = [
    "xref",
    `0 ${offsets.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
  ].join("\n");
  const trailer = `trailer<</Size ${offsets.length + 1}/Root 1 0 R>>`;
  return `${body}\n${xref}\n${trailer}\nstartxref\n${xrefOffset}\n%%EOF`;
}

const NO_MEDIA_CFG: OpenClawConfig = {
  tools: {
    media: {
      audio: { enabled: false },
      image: { enabled: false },
      video: { enabled: false },
    },
  },
};

describe("extractFileBlocks MIME resolution", () => {
  it("preserves application/pdf instead of overriding to text/plain", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-pdf-"));
    const pdfPath = path.join(dir, "resume.pdf");
    await fs.writeFile(pdfPath, MINIMAL_PDF);

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: pdfPath,
      MediaType: "application/pdf",
    };

    const result = await applyMediaUnderstanding({ ctx, cfg: NO_MEDIA_CFG });

    expect(result.appliedFile).toBe(true);
    // The MIME type in the output block must be application/pdf, not text/plain
    expect(ctx.Body).toContain('mime="application/pdf"');
    expect(ctx.Body).not.toContain('mime="text/plain"');
  });

  it("extracts text content from PDF via the pdf extraction path", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-pdf-"));
    const pdfPath = path.join(dir, "report.pdf");
    await fs.writeFile(pdfPath, buildPdfWithText("Hello World"));

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: pdfPath,
      MediaType: "application/pdf",
    };

    const result = await applyMediaUnderstanding({ ctx, cfg: NO_MEDIA_CFG });

    expect(result.appliedFile).toBe(true);
    expect(ctx.Body).toContain('mime="application/pdf"');
    // Verify actual text extraction happened (not raw binary dump)
    expect(ctx.Body).toContain("Hello World");
    expect(ctx.Body).not.toContain("%PDF");
  });

  it("still allows extension-based MIME override for .txt files with pdf content", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-pdf-"));
    // A .txt file that happens to have application/pdf rawMime — extension wins
    const txtPath = path.join(dir, "notes.txt");
    await fs.writeFile(txtPath, "plain text content, not a real PDF");

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: txtPath,
      MediaType: "application/pdf",
    };

    const result = await applyMediaUnderstanding({ ctx, cfg: NO_MEDIA_CFG });

    expect(result.appliedFile).toBe(true);
    // Extension-based override should produce text/plain, not application/pdf
    expect(ctx.Body).toContain('mime="text/plain"');
    expect(ctx.Body).toContain("plain text content");
  });

  it("does not affect non-PDF MIME types (text heuristic still applies)", async () => {
    const { applyMediaUnderstanding } = await loadApply();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-pdf-"));
    const binPath = path.join(dir, "data.bin");
    await fs.writeFile(binPath, "just some plain text in a bin file");

    const ctx: MsgContext = {
      Body: "<media:document>",
      MediaPath: binPath,
      MediaType: "application/octet-stream",
    };

    const result = await applyMediaUnderstanding({ ctx, cfg: NO_MEDIA_CFG });

    // application/octet-stream is binary — should be skipped by isBinaryMediaMime
    expect(result.appliedFile).toBe(false);
  });
});
