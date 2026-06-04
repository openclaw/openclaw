import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyInboundPdfContextIfNeeded,
  buildEmbeddedInboundPdfContextFromPrompt,
} from "./inbound-pdf-context.js";

const runtimeMocks = vi.hoisted(() => ({
  extractPdfContent: vi.fn(),
  resolveInboundMediaReference: vi.fn(),
}));

vi.mock("./inbound-pdf-context.runtime.js", () => runtimeMocks);

describe("inbound PDF prompt context", () => {
  let tempDir: string;
  let pdfPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-pdf-context-"));
    pdfPath = path.join(tempDir, "report.pdf");
    await fs.writeFile(pdfPath, "%PDF-1.4\n");
    runtimeMocks.resolveInboundMediaReference.mockReset();
    runtimeMocks.extractPdfContent.mockReset();
    runtimeMocks.resolveInboundMediaReference.mockResolvedValue({
      id: "report.pdf",
      normalizedSource: "media://inbound/report.pdf",
      physicalPath: pdfPath,
      sourceType: "uri",
    });
    runtimeMocks.extractPdfContent.mockResolvedValue({
      text: "Quarterly revenue increased 22%.",
      images: [],
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("attaches bounded untrusted PDF text for managed inbound media context", async () => {
    const ctx: { MediaPath: string; MediaType: string; MediaExtractedContext?: string } = {
      MediaPath: "media://inbound/report.pdf",
      MediaType: "application/pdf",
    };

    await expect(
      applyInboundPdfContextIfNeeded({
        ctx,
        cfg: {} as OpenClawConfig,
      }),
    ).resolves.toBe(true);

    expect(runtimeMocks.resolveInboundMediaReference).toHaveBeenCalledWith(
      "media://inbound/report.pdf",
    );
    expect(runtimeMocks.extractPdfContent).toHaveBeenCalledWith(
      expect.objectContaining({
        maxPages: 20,
        maxPixels: 1,
        minTextChars: 0,
      }),
    );
    expect(ctx.MediaExtractedContext).toContain("PDF attachment text extracted from inbound media");
    expect(ctx.MediaExtractedContext).toContain("untrusted document content");
    expect(ctx.MediaExtractedContext).toContain("Quarterly revenue increased 22%.");
  });

  it("does not read PDF-looking paths that are not managed inbound media references", async () => {
    runtimeMocks.resolveInboundMediaReference.mockResolvedValue(null);
    const ctx: { MediaPath: string; MediaType: string; MediaExtractedContext?: string } = {
      MediaPath: "/tmp/not-managed/report.pdf",
      MediaType: "application/pdf",
    };

    await expect(
      applyInboundPdfContextIfNeeded({
        ctx,
        cfg: {} as OpenClawConfig,
      }),
    ).resolves.toBe(true);

    expect(runtimeMocks.resolveInboundMediaReference).toHaveBeenCalledWith(
      "/tmp/not-managed/report.pdf",
    );
    expect(runtimeMocks.extractPdfContent).not.toHaveBeenCalled();
    expect(ctx.MediaExtractedContext).toContain(
      "managed inbound media reference could not be resolved",
    );
  });

  it("extracts embedded runner context only from managed inbound PDF references", async () => {
    const context = await buildEmbeddedInboundPdfContextFromPrompt({
      prompt: "Please summarize [media attached: media://inbound/report.pdf | application/pdf]",
      cfg: {} as OpenClawConfig,
    });

    expect(context).toContain("PDF attachment text extracted from inbound media");
    expect(context).toContain("Quarterly revenue increased 22%.");
  });

  it("extracts managed inbound PDFs in the chat.send pass-through range above the old 10 MB default", async () => {
    // chat.send accepts and passes managed PDFs through up to the default 20 MB
    // limit, so a 15 MB PDF must still be extracted (not skipped) or a
    // locked-down agent only sees the attachment marker without document text.
    const largePdfPath = path.join(tempDir, "large-report.pdf");
    await fs.writeFile(largePdfPath, "%PDF-1.4\n");
    await fs.truncate(largePdfPath, 15 * 1024 * 1024);
    runtimeMocks.resolveInboundMediaReference.mockResolvedValue({
      id: "large-report.pdf",
      normalizedSource: "media://inbound/large-report.pdf",
      physicalPath: largePdfPath,
      sourceType: "uri",
    });

    const ctx: { MediaPath: string; MediaType: string; MediaExtractedContext?: string } = {
      MediaPath: "media://inbound/large-report.pdf",
      MediaType: "application/pdf",
    };

    await expect(
      applyInboundPdfContextIfNeeded({
        ctx,
        cfg: {} as OpenClawConfig,
      }),
    ).resolves.toBe(true);

    expect(runtimeMocks.extractPdfContent).toHaveBeenCalled();
    expect(ctx.MediaExtractedContext).toContain("PDF attachment text extracted from inbound media");
    expect(ctx.MediaExtractedContext).toContain("Quarterly revenue increased 22%.");
    expect(ctx.MediaExtractedContext).not.toContain("safety limit");
  });

  it("still skips inbound PDFs above the extraction safety ceiling", async () => {
    const hugePdfPath = path.join(tempDir, "huge-report.pdf");
    await fs.writeFile(hugePdfPath, "%PDF-1.4\n");
    await fs.truncate(hugePdfPath, 26 * 1024 * 1024);
    runtimeMocks.resolveInboundMediaReference.mockResolvedValue({
      id: "huge-report.pdf",
      normalizedSource: "media://inbound/huge-report.pdf",
      physicalPath: hugePdfPath,
      sourceType: "uri",
    });

    const ctx: { MediaPath: string; MediaType: string; MediaExtractedContext?: string } = {
      MediaPath: "media://inbound/huge-report.pdf",
      MediaType: "application/pdf",
    };

    await expect(
      applyInboundPdfContextIfNeeded({
        ctx,
        cfg: {} as OpenClawConfig,
      }),
    ).resolves.toBe(true);

    expect(runtimeMocks.extractPdfContent).not.toHaveBeenCalled();
    expect(ctx.MediaExtractedContext).toContain("extraction skipped");
    expect(ctx.MediaExtractedContext).toContain("safety limit");
  });
});
