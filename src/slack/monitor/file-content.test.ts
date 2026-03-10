import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFetchError } from "../../media/fetch.js";
import * as mediaFetch from "../../media/fetch.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import { resolveSlackFileContent } from "./file-content.js";

async function makeOoxmlZip(opts: {
  mainMime: string;
  partPath: string;
  partBody: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="${opts.partPath}" ContentType="${opts.mainMime}.main+xml"/></Types>`,
  );
  zip.file(opts.partPath.slice(1), opts.partBody);
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("resolveSlackFileContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts markdown/text/json/csv content into snippets", async () => {
    const fetchRemoteMediaMock = vi.spyOn(mediaFetch, "fetchRemoteMedia");
    fetchRemoteMediaMock
      .mockResolvedValueOnce({
        buffer: Buffer.from("# Heading\nBody"),
        contentType: "text/markdown",
        fileName: "a.md",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('{"a":1,"b":2}'),
        contentType: "application/json",
        fileName: "b.json",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("x,y\n1,2"),
        contentType: "text/csv",
        fileName: "c.csv",
      });

    const result = await resolveSlackFileContent({
      files: [
        { name: "a.md", url_private: "https://files.slack.com/a.md" },
        { name: "b.json", url_private: "https://files.slack.com/b.json" },
        { name: "c.csv", url_private: "https://files.slack.com/c.csv" },
      ],
      token: "xoxb-test",
      maxBytes: 1024 * 1024,
    });

    expect(result.issues).toEqual([]);
    expect(result.snippets).toHaveLength(3);
    expect(result.snippets[0]?.fileName).toBe("a.md");
    expect(result.snippets[0]?.text).toContain("Heading");
    expect(result.snippets[1]?.text).toContain('"a": 1');
    expect(result.snippets[2]?.text).toContain("x,y");
  });

  it("extracts PDF text when available", async () => {
    vi.spyOn(mediaFetch, "fetchRemoteMedia").mockResolvedValueOnce({
      buffer: Buffer.from("%PDF"),
      contentType: "application/pdf",
      fileName: "doc.pdf",
    });
    vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValueOnce({
      text: "PDF body text",
      images: [],
    });

    const result = await resolveSlackFileContent({
      files: [{ name: "doc.pdf", url_private: "https://files.slack.com/doc.pdf" }],
      token: "xoxb-test",
      maxBytes: 1024 * 1024,
    });

    expect(result.issues).toEqual([]);
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]?.text).toContain("PDF body text");
  });

  it("extracts DOCX/XLSX/PPTX text", async () => {
    const docxBuffer = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      partPath: "/word/document.xml",
      partBody:
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX text</w:t></w:r></w:p></w:body></w:document>',
    });

    const xlsxZip = new JSZip();
    xlsxZip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    );
    xlsxZip.file(
      "xl/sharedStrings.xml",
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Header</t></si><si><t>Value</t></si></sst>',
    );
    xlsxZip.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
    );
    const xlsxBuffer = await xlsxZip.generateAsync({ type: "nodebuffer" });

    const pptxBuffer = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      partPath: "/ppt/slides/slide1.xml",
      partBody:
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>PPTX text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    });

    const fetchRemoteMediaMock = vi.spyOn(mediaFetch, "fetchRemoteMedia");
    fetchRemoteMediaMock
      .mockResolvedValueOnce({
        buffer: docxBuffer,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "a.docx",
      })
      .mockResolvedValueOnce({
        buffer: xlsxBuffer,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: "b.xlsx",
      })
      .mockResolvedValueOnce({
        buffer: pptxBuffer,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        fileName: "c.pptx",
      });

    const result = await resolveSlackFileContent({
      files: [
        { name: "a.docx", url_private: "https://files.slack.com/a.docx" },
        { name: "b.xlsx", url_private: "https://files.slack.com/b.xlsx" },
        { name: "c.pptx", url_private: "https://files.slack.com/c.pptx" },
      ],
      token: "xoxb-test",
      maxBytes: 1024 * 1024,
    });

    expect(result.issues).toEqual([]);
    expect(result.snippets).toHaveLength(3);
    expect(result.snippets[0]?.text).toContain("DOCX text");
    expect(result.snippets[1]?.text).toContain("Header");
    expect(result.snippets[1]?.text).toContain("Value");
    expect(result.snippets[2]?.text).toContain("PPTX text");
  });

  it("reports permission errors for missing scope/auth", async () => {
    vi.spyOn(mediaFetch, "fetchRemoteMedia").mockRejectedValueOnce(
      new Error("An API error occurred: missing_scope"),
    );

    const result = await resolveSlackFileContent({
      files: [{ name: "secret.md", url_private: "https://files.slack.com/secret.md" }],
      token: "xoxb-test",
      maxBytes: 1024 * 1024,
    });

    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([
      {
        fileName: "secret.md",
        reason: "permission",
      },
    ]);
  });

  it("reports size and unsupported format failures", async () => {
    const fetchRemoteMediaMock = vi.spyOn(mediaFetch, "fetchRemoteMedia");
    fetchRemoteMediaMock
      .mockRejectedValueOnce(new MediaFetchError("max_bytes", "too large"))
      .mockResolvedValueOnce({
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
        fileName: "photo.jpg",
      });

    const result = await resolveSlackFileContent({
      files: [
        { name: "too-big.txt", url_private: "https://files.slack.com/too-big.txt" },
        { name: "photo.jpg", url_private: "https://files.slack.com/photo.jpg" },
      ],
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([
      {
        fileName: "too-big.txt",
        reason: "size_exceeded",
      },
      {
        fileName: "photo.jpg",
        reason: "unsupported_format",
      },
    ]);
  });
});
