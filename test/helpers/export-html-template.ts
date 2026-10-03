// Shared exported HTML fixtures use the real template and generated browser vendors.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { generateExportHtmlVendorAssets } from "../../scripts/runtime-postbuild.mts";

export type SessionEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  message?: unknown;
  summary?: string;
  content?: unknown;
  targetId?: string | null;
  appendParentId?: string | null;
  display?: boolean;
  customType?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
};

export type SessionData = {
  header: { id: string; timestamp: string };
  entries: SessionEntry[];
  leafId: string | null;
  hasLeafControl?: boolean;
  systemPrompt: string;
  tools: unknown[];
  warning?: string;
};

type LinkedomModule = {
  parseHTML(html: string): { document: Document };
};

const LINKEDOM_MODULE = "linkedom";

const exportHtmlDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/auto-reply/reply/export-html",
);
export const templateHtml = fs.readFileSync(path.join(exportHtmlDir, "template.html"), "utf8");
export const templateCss = fs.readFileSync(path.join(exportHtmlDir, "template.css"), "utf8");
const templateJs = fs.readFileSync(path.join(exportHtmlDir, "template.js"), "utf8");
const vendorAssets = generateExportHtmlVendorAssets();
const markedJs = expectDefined(vendorAssets["marked.min.js"], "generated marked browser asset");
const highlightJs = expectDefined(
  vendorAssets["highlight.min.js"],
  "generated highlight browser asset",
);

let parseHtmlPromise: Promise<LinkedomModule["parseHTML"]> | null = null;

async function loadParseHTML(): Promise<LinkedomModule["parseHTML"]> {
  parseHtmlPromise ??= (import(LINKEDOM_MODULE) as Promise<LinkedomModule>).then(
    (module) => module["parseHTML"],
  );
  return parseHtmlPromise;
}

export async function renderTemplate(sessionData: SessionData) {
  const html = [
    ["CSS", ""],
    ["SESSION_DATA", Buffer.from(JSON.stringify(sessionData), "utf8").toString("base64")],
    ["MARKED_JS", ""],
    ["HIGHLIGHT_JS", ""],
    ["JS", ""],
  ].reduce(
    (currentHtml, [name, value]) =>
      currentHtml.replace(
        new RegExp(
          `(<(?:script|style)\\b(?=[^>]*\\bdata-openclaw-export-placeholder="${name}")[^>]*>)(</(?:script|style)>)`,
        ),
        (_match: string, openTag: string, closeTag: string) =>
          `${openTag.replace(/\sdata-openclaw-export-placeholder="[^"]*"/, "")}${value}${closeTag}`,
      ),
    templateHtml,
  );

  const parseHTML = await loadParseHTML();
  const { document } = parseHTML(html);
  const downloads: Blob[] = [];

  const immediateTimeout = (fn: (...args: unknown[]) => void) => {
    fn();
    return 0;
  };
  const runtime: Record<string, unknown> = {
    document,
    console,
    clearTimeout: () => {},
    setTimeout: immediateTimeout,
    URLSearchParams,
    Blob,
    URL: class extends URL {
      static override createObjectURL(blob: Blob) {
        downloads.push(blob);
        return "blob:session-export";
      }
      static override revokeObjectURL() {}
    },
    TextDecoder,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    navigator: { clipboard: { writeText: async () => {} } },
    history: { replaceState: () => {} },
    location: { href: "http://localhost/export.html", search: "" },
  };
  runtime.window = runtime;
  runtime.self = runtime;
  runtime.globalThis = runtime;

  vm.createContext(runtime);
  vm.runInContext(markedJs, runtime);
  vm.runInContext(highlightJs, runtime);
  vm.runInContext(templateJs, runtime);
  return {
    document,
    downloadJson: async () => {
      vm.runInContext("downloadSessionJson()", runtime);
      return await expectDefined(downloads.at(-1), "download missing").text();
    },
  };
}

export function now() {
  return new Date("2026-02-24T00:00:00.000Z").toISOString();
}

export function requireElement<T extends Element>(element: T | null, message: string): T {
  if (!element) {
    throw new Error(message);
  }
  return element;
}
