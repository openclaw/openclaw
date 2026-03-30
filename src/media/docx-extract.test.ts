import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractDocxText } from "./docx-extract.js";

async function makeDocx(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file("word/document.xml", documentXml);
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("extractDocxText", () => {
  it("extracts paragraph text from a docx buffer", async () => {
    const buffer = await makeDocx(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p></w:body></w:document>',
    );

    await expect(extractDocxText({ buffer })).resolves.toBe("Hello\n\nWorld");
  });

  it("extracts simple table text and decodes XML entities", async () => {
    const buffer = await makeDocx(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Revenue &amp; Margin</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    );

    await expect(extractDocxText({ buffer })).resolves.toBe("Revenue & Margin\t42");
  });
});
