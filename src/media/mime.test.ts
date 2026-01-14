import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { detectMime, imageMimeFromFormat } from "./mime.js";

async function makeOoxmlZip(opts: { mainMime: string; partPath: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types><Override PartName="${opts.partPath}" ContentType="${opts.mainMime}.main+xml"/></Types>`,
  );
  zip.file(opts.partPath.slice(1), "<xml/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("mime detection", () => {
  it("maps common image formats to mime types", () => {
    expect(imageMimeFromFormat("jpg")).toBe("image/jpeg");
    expect(imageMimeFromFormat("jpeg")).toBe("image/jpeg");
    expect(imageMimeFromFormat("png")).toBe("image/png");
    expect(imageMimeFromFormat("webp")).toBe("image/webp");
    expect(imageMimeFromFormat("gif")).toBe("image/gif");
    expect(imageMimeFromFormat("unknown")).toBeUndefined();
  });

  it("detects docx from buffer", async () => {
    const buf = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      partPath: "/word/document.xml",
    });
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/file.bin" });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("detects pptx from buffer", async () => {
    const buf = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      partPath: "/ppt/presentation.xml",
    });
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/file.bin" });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  it("prefers extension mapping over generic zip", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const buf = await zip.generateAsync({ type: "nodebuffer" });

    const mime = await detectMime({
      buffer: buf,
      filePath: "/tmp/file.xlsx",
    });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});
