import JSZip from "jszip";

const DOCX_TEXT_PLACEHOLDER_PREFIX = "__openclaw_docx_text_";
export const DEFAULT_DOCX_XML_MAX_BYTES = 256 * 1024;

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

  const textNodes: string[] = [];
  const withTextPlaceholders = withStructuralBreaks.replace(
    /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g,
    (_match, textContent: string) => {
      const index = textNodes.push(textContent) - 1;
      return `${DOCX_TEXT_PLACEHOLDER_PREFIX}${index}__`;
    },
  );

  const text = withTextPlaceholders
    .replace(/<[^>]+>/g, "")
    .replace(new RegExp(`${DOCX_TEXT_PLACEHOLDER_PREFIX}(\\d+)__`, "g"), (_match, index) =>
      decodeXmlEntities(textNodes[Number(index)] ?? ""),
    );

  return normalizeDocxWhitespace(text);
}

export async function extractDocxText(params: {
  buffer: Buffer;
  maxXmlBytes?: number;
}): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(params.buffer);
    const documentXmlFile = zip.file("word/document.xml");
    if (!documentXmlFile) {
      return "";
    }
    const documentXmlBytes = await documentXmlFile.async("uint8array");
    if (
      typeof params.maxXmlBytes === "number" &&
      Number.isFinite(params.maxXmlBytes) &&
      params.maxXmlBytes > 0 &&
      documentXmlBytes.byteLength > params.maxXmlBytes
    ) {
      return "";
    }
    const documentXml = new TextDecoder().decode(documentXmlBytes);
    return extractDocxTextFromXml(documentXml);
  } catch {
    return "";
  }
}
