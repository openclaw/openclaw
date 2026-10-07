import type { SessionsFilesAssetsResult } from "@openclaw/gateway-protocol";
import { defaultTreeAdapter, html, parse, type DefaultTreeAdapterTypes } from "parse5";
import { SESSIONS_FILES_ASSETS_MAX_REFS } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";

type Asset = SessionsFilesAssetsResult["assets"][number];
type LoadedAsset = Extract<Asset, { content: string }>;
type Edit = { start: number; end: number; text: string };
type Reference = { start: number; end: number; ref: string };
type TextAssets = {
  start: number;
  end: number;
  source: string;
  refs: Reference[];
  attribute?: string;
};
type ExternalElement = { node: DefaultTreeAdapterTypes.Element; ref: string };

const FONT_PATH = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;

function relativeRef(value: string): string | undefined {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  const ref = value.slice(start, end);
  return ref && !/^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(ref) ? ref : undefined;
}

function applyEdits(source: string, edits: Edit[]): string {
  let position = 0;
  const parts: string[] = [];
  // Recovery can duplicate elements; whole-element edits supersede their attributes.
  const unique = new Map(edits.map((edit) => [edit.start, edit]));
  for (const edit of [...unique.values()].toSorted((a, b) => a.start - b.start)) {
    if (edit.start < position) {
      continue;
    }
    parts.push(source.slice(position, edit.start), edit.text);
    position = edit.end;
  }
  parts.push(source.slice(position));
  return parts.join("");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function srcsetRefs(value: string): Reference[] {
  const refs: Reference[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[ \t\n\f\r,]/.test(value[cursor] ?? "") && cursor < value.length) {
      cursor += 1;
    }
    const start = cursor;
    while (cursor < value.length && !/[ \t\n\f\r]/.test(value[cursor]!)) {
      cursor += 1;
    }
    let end = cursor;
    while (value[end - 1] === ",") {
      end -= 1;
    }
    const ref = relativeRef(value.slice(start, end));
    if (ref) {
      refs.push({ start, end, ref });
    }
    if (end !== cursor) {
      continue;
    }
    let parentheses = 0;
    while (cursor < value.length) {
      const char = value[cursor++];
      if (char === "(") {
        parentheses += 1;
      }
      if (char === ")") {
        parentheses -= 1;
      }
      if (char === "," && parentheses === 0) {
        break;
      }
    }
  }
  return refs;
}

function cssRefs(source: string, stylesheet = ""): Reference[] {
  const refs: Reference[] = [];
  const base = stylesheet.split(/[?#]/, 1)[0] ?? "";
  const directory = base.slice(0, base.lastIndexOf("/") + 1);
  // Tokenize strings/comments before url() so their lookalikes remain literal.
  const tokens =
    /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|@import\b[^;{}]*;|@font-face\b|(?<![\w-])url\((?:\s*"(?:\\[\s\S]|[^"\\])*"\s*|\s*'(?:\\[\s\S]|[^'\\])*'\s*|(?:\\[\s\S]|[^)"'\\])*)\)|[{}]/gi;
  let depth = 0;
  let fontDepth: number | undefined;
  let fontPending = false;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token.toLowerCase() === "@font-face") {
      fontPending = true;
    } else if (token === "{") {
      depth += 1;
      if (fontPending) {
        fontDepth = depth;
      }
      fontPending = false;
    } else if (token === "}") {
      if (fontDepth === depth) {
        fontDepth = undefined;
      }
      depth -= 1;
    } else if (fontDepth === undefined && /^url\(/i.test(token)) {
      let value = token.slice(4, -1).trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        value = value.slice(1, -1);
      }
      value = value.replace(
        /\\(?:([a-f\d]{1,6})\s?|([^\r\n]))/gi,
        (_escape, hex: string | undefined, char: string | undefined) => {
          const code = hex ? Number.parseInt(hex, 16) : 0;
          return hex
            ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd)
            : (char ?? "");
        },
      );
      const ref = relativeRef(value);
      if (ref && !FONT_PATH.test(ref)) {
        refs.push({ start: match.index, end: match.index + token.length, ref: directory + ref });
      }
    }
  }
  return refs;
}

function retainedAttributes(
  source: string,
  node: DefaultTreeAdapterTypes.Element,
  omit: string[],
): string {
  const attrs = node.attrs
    .filter((attr) => !omit.includes(attr.name))
    .map((attr) => {
      const range = node.sourceCodeLocation?.attrs?.[attr.name];
      return range ? source.slice(range.startOffset, range.endOffset) : "";
    })
    .filter(Boolean)
    .join(" ");
  return attrs ? ` ${attrs}` : "";
}

function decodeText(asset: LoadedAsset): string {
  return new TextDecoder().decode(base64ToBytes(asset.content));
}

function dataUrl(asset: LoadedAsset, ref: string): string | undefined {
  if (/^(?:font\/|application\/(?:font|x-font))/i.test(asset.mimeType)) {
    return undefined;
  }
  const fragment = ref.includes("#") ? new URL(ref, "https://preview.invalid/").hash : "";
  return `data:${asset.mimeType};base64,${asset.content}${fragment}`;
}

/** Inline only asset locations; all other authored bytes and link semantics stay intact. */
export async function prepareHtmlPreviewAssets(
  source: string,
  allowScripts: boolean,
  fetchAssets: (refs: string[]) => Promise<SessionsFilesAssetsResult>,
): Promise<{ html: string; omitted: number }> {
  const document = parse(source, { scriptingEnabled: allowScripts, sourceCodeLocationInfo: true });
  const texts: TextAssets[] = [];
  const stylesheets: ExternalElement[] = [];
  const scripts: ExternalElement[] = [];
  const requested = new Set<string>();
  const pending: DefaultTreeAdapterTypes.Node[] = document.childNodes.toReversed();
  const addText = (text: TextAssets) => {
    if (text.refs.length === 0) {
      return;
    }
    texts.push(text);
    for (const { ref } of text.refs) {
      requested.add(ref);
    }
  };
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!defaultTreeAdapter.isElementNode(node)) {
      continue;
    }
    pending.push(...node.childNodes.toReversed());
    const htmlElement = node.namespaceURI === html.NS.HTML;
    const attr = (name: string) => node.attrs.find((entry) => entry.name === name)?.value;
    if (htmlElement && node.tagName === "base" && attr("href") !== undefined) {
      return { html: source, omitted: 0 };
    }
    const location = node.sourceCodeLocation;
    if (!location) {
      continue;
    }
    for (const attribute of node.attrs) {
      const loc = location.attrs?.[attribute.name];
      if (!loc) {
        continue;
      }
      let refs: Reference[] = [];
      if (attribute.name === "style") {
        refs = cssRefs(attribute.value);
      } else if (
        htmlElement &&
        ((["img", "source"].includes(node.tagName) && ["src", "srcset"].includes(attribute.name)) ||
          (node.tagName === "video" && ["src", "poster"].includes(attribute.name)) ||
          (node.tagName === "audio" && attribute.name === "src") ||
          (node.tagName === "input" &&
            attr("type")?.toLowerCase() === "image" &&
            attribute.name === "src"))
      ) {
        const ref = relativeRef(attribute.value);
        refs =
          attribute.name === "srcset"
            ? srcsetRefs(attribute.value)
            : ref
              ? [{ start: 0, end: attribute.value.length, ref }]
              : [];
      }
      addText({
        start: loc.startOffset,
        end: loc.endOffset,
        source: attribute.value,
        refs,
        attribute: attribute.name,
      });
    }
    if (node.tagName === "style" && location.startTag && location.endTag) {
      const css = source.slice(location.startTag.endOffset, location.endTag.startOffset);
      addText({
        start: location.startTag.endOffset,
        end: location.endTag.startOffset,
        source: css,
        refs: cssRefs(css),
      });
    }
    if (!htmlElement) {
      continue;
    }
    const externalRef = relativeRef(attr(node.tagName === "link" ? "href" : "src") ?? "");
    if (
      externalRef &&
      node.tagName === "link" &&
      attr("rel")?.toLowerCase().split(/\s+/).includes("stylesheet")
    ) {
      stylesheets.push({ node, ref: externalRef });
      requested.add(externalRef);
    } else if (externalRef && node.tagName === "script" && location.endTag) {
      scripts.push({ node, ref: externalRef });
      requested.add(externalRef);
    }
  }
  const loaded = new Map<string, LoadedAsset>();
  const omitted = new Set<string>();
  const fetch = async (refs: Set<string>) => {
    const all = [...refs].filter((ref) => !loaded.has(ref) && !omitted.has(ref));
    const batch = all.slice(0, SESSIONS_FILES_ASSETS_MAX_REFS);
    for (const ref of all.slice(SESSIONS_FILES_ASSETS_MAX_REFS)) {
      omitted.add(ref);
    }
    if (!batch.length) {
      return;
    }
    try {
      const result = await fetchAssets(batch);
      for (const asset of result.assets) {
        if ("content" in asset) {
          loaded.set(asset.ref, asset);
        }
      }
    } catch {
      // The document remains useful even if its optional asset read fails.
    }
    for (const ref of batch) {
      if (!loaded.has(ref)) {
        omitted.add(ref);
      }
    }
  };
  await fetch(requested);
  const cssByRef = new Map<string, { source: string; refs: Reference[] }>();
  const nested = new Set<string>();
  for (const { ref } of stylesheets) {
    const asset = loaded.get(ref);
    if (!asset) {
      continue;
    }
    const css = decodeText(asset);
    const refs = cssRefs(css, ref);
    cssByRef.set(ref, { source: css, refs });
    for (const nestedRef of refs) {
      nested.add(nestedRef.ref);
    }
  }
  await fetch(nested);
  const inline = (text: string, refs: Reference[], css: boolean) =>
    applyEdits(
      text,
      refs.flatMap((ref) => {
        const asset = loaded.get(ref.ref);
        const url = asset && dataUrl(asset, ref.ref);
        return url
          ? [{ start: ref.start, end: ref.end, text: css ? `url(${JSON.stringify(url)})` : url }]
          : [];
      }),
    );
  const edits: Edit[] = texts.flatMap((text) => {
    const content = inline(text.source, text.refs, !text.attribute || text.attribute === "style");
    return content === text.source
      ? []
      : [
          {
            start: text.start,
            end: text.end,
            text: text.attribute ? `${text.attribute}="${escapeAttribute(content)}"` : content,
          },
        ];
  });
  for (const { node, ref } of stylesheets) {
    const css = cssByRef.get(ref);
    const loc = node.sourceCodeLocation;
    if (!css || !loc) {
      continue;
    }
    const attrs = retainedAttributes(source, node, ["rel", "href", "integrity", "crossorigin"]);
    const content = inline(css.source, css.refs, true).replace(/<\/style/gi, "\\3c /style");
    edits.push({
      start: loc.startOffset,
      end: loc.endOffset,
      text: `<style${attrs}>${content}</style>`,
    });
  }
  for (const { node, ref } of scripts) {
    const asset = loaded.get(ref);
    const loc = node.sourceCodeLocation;
    const src = loc?.attrs?.src;
    if (!asset || !src || !loc?.startTag || !loc.endTag) {
      continue;
    }
    const deferred =
      node.attrs.some((attr) => attr.name === "defer") &&
      !node.attrs.some(
        (attr) =>
          attr.name === "async" || (attr.name === "type" && attr.value.toLowerCase() === "module"),
      );
    if (deferred) {
      const payload = JSON.stringify({
        attributes: node.attrs
          .filter(
            (attr) =>
              !["src", "defer", "async", "type", "integrity", "crossorigin"].includes(attr.name),
          )
          .map((attr) => [attr.name, attr.value]),
        code: decodeText(asset),
      })
        .replaceAll("<", "\\u003c")
        .replaceAll("\u2028", "\\u2028")
        .replaceAll("\u2029", "\\u2029");
      // Modules share the post-parse queue; the inserted classic keeps global/sloppy semantics.
      edits.push({
        start: loc.startOffset,
        end: loc.endOffset,
        text: `<script type="module">const {attributes,code}=${payload};const script=document.createElement("script");for(const [name,value] of attributes)script.setAttribute(name,value);script.textContent=code;(document.head??document.documentElement).appendChild(script);</script>`,
      });
      continue;
    }
    const attrs = retainedAttributes(source, node, ["src", "integrity", "crossorigin"]);
    const content = decodeText(asset).replace(/<\/script/gi, "<\\/script");
    edits.push({
      start: loc.startTag.startOffset,
      end: loc.startTag.endOffset,
      text: `<script${attrs}>`,
    });
    edits.push({
      start: loc.startTag.endOffset,
      end: loc.endTag.startOffset,
      text: content,
    });
  }
  return { html: applyEdits(source, edits), omitted: omitted.size };
}
