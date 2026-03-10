import JSZip from "jszip";
import { getFileExtension, normalizeMimeType } from "../../media/mime.js";

type OfficeKind = "docx" | "xlsx" | "pptx";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, num: string) => String.fromCodePoint(Number.parseInt(num, 10)));
}

function normalizeExtractedText(raw: string): string {
  return decodeXmlEntities(raw).replace(/\s+/g, " ").trim();
}

function resolveOfficeKind(params: { mimeType?: string; fileName: string }): OfficeKind | null {
  const mimeType = normalizeMimeType(params.mimeType);
  if (mimeType === DOCX_MIME) {
    return "docx";
  }
  if (mimeType === XLSX_MIME) {
    return "xlsx";
  }
  if (mimeType === PPTX_MIME) {
    return "pptx";
  }
  const ext = getFileExtension(params.fileName);
  if (ext === ".docx") {
    return "docx";
  }
  if (ext === ".xlsx") {
    return "xlsx";
  }
  if (ext === ".pptx") {
    return "pptx";
  }
  return null;
}

function extractTagValues(xml: string, tagPattern: RegExp): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(tagPattern)) {
    const value = normalizeExtractedText(match[1] ?? "");
    if (value) {
      values.push(value);
    }
  }
  return values;
}

async function extractDocxText(zip: JSZip): Promise<string> {
  const paths = Object.keys(zip.files)
    .filter((path) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(path))
    .toSorted();
  const chunks: string[] = [];
  for (const path of paths) {
    const file = zip.file(path);
    if (!file) {
      continue;
    }
    const xml = await file.async("text");
    chunks.push(...extractTagValues(xml, /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi));
  }
  return chunks.join("\n");
}

async function extractXlsxText(zip: JSZip): Promise<string> {
  const sharedStrings = new Map<number, string>();
  const sharedFile = zip.file("xl/sharedStrings.xml");
  if (sharedFile) {
    const xml = await sharedFile.async("text");
    const siMatches = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi);
    let idx = 0;
    for (const match of siMatches) {
      const text = extractTagValues(match[1] ?? "", /<t\b[^>]*>([\s\S]*?)<\/t>/gi).join("");
      if (text) {
        sharedStrings.set(idx, text);
      }
      idx += 1;
    }
  }

  const sheetPaths = Object.keys(zip.files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .toSorted();
  const rows: string[] = [];
  for (const path of sheetPaths) {
    const file = zip.file(path);
    if (!file) {
      continue;
    }
    const xml = await file.async("text");
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
      const rowXml = rowMatch[1] ?? "";
      const cells: string[] = [];
      for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = cellMatch[1] ?? "";
        const cellXml = cellMatch[2] ?? "";
        const typeMatch = /\bt="([^"]+)"/i.exec(attrs);
        const cellType = typeMatch?.[1];
        if (cellType === "s") {
          const valueMatch = /<v>([\s\S]*?)<\/v>/i.exec(cellXml);
          const index = Number.parseInt((valueMatch?.[1] ?? "").trim(), 10);
          const resolved = sharedStrings.get(index);
          if (resolved) {
            cells.push(resolved);
          }
          continue;
        }
        if (cellType === "inlineStr") {
          const inline = extractTagValues(cellXml, /<t\b[^>]*>([\s\S]*?)<\/t>/gi).join("");
          if (inline) {
            cells.push(inline);
          }
          continue;
        }
        const rawValueMatch = /<v>([\s\S]*?)<\/v>/i.exec(cellXml);
        const rawValue = normalizeExtractedText(rawValueMatch?.[1] ?? "");
        if (rawValue) {
          cells.push(rawValue);
        }
      }
      if (cells.length > 0) {
        rows.push(cells.join(", "));
      }
    }
  }
  return rows.join("\n");
}

async function extractPptxText(zip: JSZip): Promise<string> {
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .toSorted();
  const chunks: string[] = [];
  for (const path of slidePaths) {
    const file = zip.file(path);
    if (!file) {
      continue;
    }
    const xml = await file.async("text");
    chunks.push(...extractTagValues(xml, /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi));
  }
  return chunks.join("\n");
}

export async function extractOfficeOpenXmlText(params: {
  buffer: Buffer;
  mimeType?: string;
  fileName: string;
}): Promise<string | null> {
  const kind = resolveOfficeKind({ mimeType: params.mimeType, fileName: params.fileName });
  if (!kind) {
    return null;
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(params.buffer);
  } catch {
    return null;
  }
  const text =
    kind === "docx"
      ? await extractDocxText(zip)
      : kind === "xlsx"
        ? await extractXlsxText(zip)
        : await extractPptxText(zip);
  const normalized = normalizeExtractedText(text);
  return normalized || null;
}
