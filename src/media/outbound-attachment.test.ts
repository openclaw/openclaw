import { afterEach, describe, expect, it, vi } from "vitest";

const loadWebMedia = vi.hoisted(() => vi.fn());
const markTrustedGeneratedHtmlPath = vi.hoisted(() => vi.fn());
const saveMediaBuffer = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("node:fs/promises", () => ({ rm }));

vi.mock("./web-media.js", () => ({
  loadWebMedia,
  markTrustedGeneratedHtmlPath,
}));

vi.mock("./store.js", () => ({
  saveMediaBuffer,
}));

const { resolveOutboundAttachmentFromBuffer, resolveOutboundAttachmentFromUrl } =
  await import("./outbound-attachment.js");

afterEach(() => vi.clearAllMocks());

const stagedHtmlPath = "/tmp/media/outbound/report---uuid.html";
function stageMedia(contentType: string, fileName?: string, trustedGeneratedHtmlSource = false) {
  const buffer = Buffer.from(
    trustedGeneratedHtmlSource ? "<!doctype html><title>report</title>" : "pdf",
  );
  const path = `/tmp/media/outbound/${(fileName ?? "report.html").replace(".", "---uuid.")}`;
  loadWebMedia.mockResolvedValueOnce({
    buffer,
    contentType,
    ...(fileName ? { fileName } : {}),
    ...(trustedGeneratedHtmlSource ? { trustedGeneratedHtmlSource } : {}),
  });
  saveMediaBuffer.mockResolvedValueOnce({ path, contentType });
  return buffer;
}

describe("resolveOutboundAttachmentFromUrl", () => {
  it("preserves the loaded file name when staging outbound media", async () => {
    const buffer = stageMedia("application/pdf", "report.pdf");

    await resolveOutboundAttachmentFromUrl("./report.pdf", 1024);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      buffer,
      "application/pdf",
      "outbound",
      1024,
      "report.pdf",
    );
    expect(markTrustedGeneratedHtmlPath).not.toHaveBeenCalled();
  });

  it("marks staged trusted HTML with its exact bytes", async () => {
    const buffer = stageMedia("text/html", "report.html", true);

    await resolveOutboundAttachmentFromUrl("/tmp/openclaw/report.html", 1024);

    expect(markTrustedGeneratedHtmlPath).toHaveBeenCalledWith(stagedHtmlPath, buffer);
  });

  it("removes the staged file and propagates marker write failures", async () => {
    stageMedia("text/html", undefined, true);
    markTrustedGeneratedHtmlPath.mockRejectedValueOnce(new Error("marker write failed"));

    await expect(
      resolveOutboundAttachmentFromUrl("/tmp/openclaw/report.html", 1024),
    ).rejects.toThrow("marker write failed");
    expect(rm).toHaveBeenCalledWith(stagedHtmlPath, { force: true });
  });
});

describe("resolveOutboundAttachmentFromBuffer", () => {
  it.each([undefined, () => {}])(
    "stages outbound buffers with metadata and an optional publication guard (%s)",
    async (assertCommitAllowed) => {
      const buffer = Buffer.from("hello");
      const saved = {
        path: "/tmp/media/outbound/note---uuid.txt",
        contentType: "text/plain",
      };
      saveMediaBuffer.mockResolvedValueOnce(saved);

      const result = await resolveOutboundAttachmentFromBuffer(buffer, 1024, {
        contentType: "text/plain",
        filename: "note.txt",
        assertCommitAllowed,
      });

      expect(saveMediaBuffer).toHaveBeenCalledWith(
        buffer,
        "text/plain",
        "outbound",
        1024,
        "note.txt",
        undefined,
        assertCommitAllowed ? { assertCommitAllowed } : undefined,
      );
      expect(result).toEqual(saved);
    },
  );
});
