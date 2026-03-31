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

  it("decodes numeric XML character references", async () => {
    const buffer = await makeDocx(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Price&#160;is&#x2019;good</w:t></w:r></w:p></w:body></w:document>',
    );

    await expect(extractDocxText({ buffer })).resolves.toBe("Price is’good");
  });

  it("preserves literal angle-bracket text encoded inside runs", async () => {
    const buffer = await makeDocx(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lt;div&gt;Hello&lt;/div&gt;</w:t></w:r></w:p></w:body></w:document>',
    );

    await expect(extractDocxText({ buffer })).resolves.toBe("<div>Hello</div>");
  });

  it("returns an empty string for malformed docx payloads", async () => {
    await expect(extractDocxText({ buffer: Buffer.from("not-a-zip") })).resolves.toBe("");
  });

  it("returns an empty string when document.xml exceeds the configured byte budget", async () => {
    const documentXml =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
      "A".repeat(128) +
      "</w:t></w:r></w:p></w:body></w:document>";
    const buffer = await makeDocx(documentXml);

    await expect(extractDocxText({ buffer, maxXmlBytes: 32 })).resolves.toBe("");
  });
});
