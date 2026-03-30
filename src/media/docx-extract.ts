import JSZip from "jszip";

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeDocxWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ ]+\t/g, "\t")
    .replace(/\t[ ]+/g, "\t")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n[ ]+/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n\n(?=\t|\n)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractDocxTextFromXml(xml: string): string {
  const withStructuralBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");

  const text = withStructuralBreaks
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_match, textContent: string) =>
      decodeXmlEntities(textContent),
    )
    .replace(/<[^>]+>/g, "");

  return normalizeDocxWhitespace(text);
}

export async function extractDocxText(params: { buffer: Buffer }): Promise<string> {
  const zip = await JSZip.loadAsync(params.buffer);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    return "";
  }
  return extractDocxTextFromXml(documentXml);
}
