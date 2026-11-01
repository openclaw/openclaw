import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import {
  defaultTreeAdapter,
  ErrorCodes,
  html,
  parse,
  parseFragment,
  type DefaultTreeAdapterTypes,
} from "parse5";

export type HtmlPreviewReference = { start: number; end: number; ref: string };
type TextAssets = {
  node: DefaultTreeAdapterTypes.Element;
  start: number;
  end: number;
  source: string;
  refs: HtmlPreviewReference[];
  attribute?: string;
};
type ExternalElement = { node: DefaultTreeAdapterTypes.Element; ref: string };
type HtmlPreviewElement = { node: DefaultTreeAdapterTypes.Element; inert: boolean };
export type HtmlPreviewAssetSelection = {
  document: DefaultTreeAdapterTypes.Document;
  elements: HtmlPreviewElement[];
  policies: HtmlPreviewElement[];
  parseError: boolean;
  texts: TextAssets[];
  stylesheets: ExternalElement[];
  scripts: ExternalElement[];
  refs: Set<string>;
  hasBaseHref: boolean;
};

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

function srcsetRefs(value: string): HtmlPreviewReference[] {
  const refs: HtmlPreviewReference[] = [];
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

const CSS_ESCAPE = String.raw`\\(?:[a-f\d]{1,6}(?:\r\n|[ \t\r\n\f])?|[^\r\n\f])`;
const CSS_NAME = String.raw`(?:[\w\-\u0080-\uffff]|${CSS_ESCAPE})+`;
const CSS_STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`;
const CSS_URL =
  /^\((?:\s*"(?:\\[\s\S]|[^"\\])*"\s*|\s*'(?:\\[\s\S]|[^'\\])*'\s*|(?:\\[\s\S]|[^)"'\\])*)\)/;

function decodeCssEscape(_escape: string, hex: string | undefined, char: string | undefined) {
  const code = hex ? Number.parseInt(hex, 16) : 0;
  return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : (char ?? "");
}

function decodeCss(value: string): string {
  return value.replace(/\\(?:([a-f\d]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n]))/gi, decodeCssEscape);
}

function hasUnescapedCssNewline(value: string): boolean {
  return /[\r\n\f]/.test(
    value.replace(/\\(?:[a-f\d]{1,6}(?:\r\n|[ \t\r\n\f])?|\r\n|[\s\S])/gi, ""),
  );
}

export function htmlPreviewCssReferences(source: string, stylesheet = ""): HtmlPreviewReference[] {
  const refs: HtmlPreviewReference[] = [];
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
      value = value.replace(/\\(?:([a-f\d]{1,6})\s?|([^\r\n]))/gi, decodeCssEscape);
      const ref = relativeRef(value);
      if (ref && !FONT_PATH.test(ref)) {
        refs.push({ start: match.index, end: match.index + token.length, ref: directory + ref });
      }
    }
  }
  return refs;
}

/** Admission only: ordinary inlining retains its original resource-selection semantics. */
export function htmlPreviewCssUnsupportedReason(source: string): string | undefined {
  // Consume strings/comments before decoding at-keywords and resource functions.
  const tokens = new RegExp(String.raw`\/\*[\s\S]*?\*\/|${CSS_STRING}|@?${CSS_NAME}|[\s\S]`, "gi");
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source))) {
    const token = match[0];
    if (token.startsWith("/*") || token.startsWith('"') || token.startsWith("'")) {
      if (token.length === 1 || (!token.startsWith("/*") && hasUnescapedCssNewline(token))) {
        return "Unrecognized CSS string syntax is unsupported.";
      }
      continue;
    }
    const name = decodeCss(token).toLowerCase();
    if (["@import", "@font-face"].includes(name)) {
      return "CSS imports and font-loading rules are unsupported.";
    } else if (source[tokens.lastIndex] === "(") {
      if (["image", "image-set", "-webkit-image-set", "src"].includes(name)) {
        return "CSS string-valued resource functions are unsupported.";
      }
      if (name !== "url") {
        continue;
      }
      const body = CSS_URL.exec(source.slice(tokens.lastIndex));
      if (!body || token.toLowerCase() !== "url") {
        return "Unrecognized CSS URL syntax is unsupported.";
      }
      tokens.lastIndex += body[0].length;
      const rawValue = body[0].slice(1, -1);
      const value = rawValue.trim();
      if (
        value !== rawValue.replace(/^[ \t\r\n\f]+|[ \t\r\n\f]+$/g, "") ||
        hasUnescapedCssNewline(value)
      ) {
        return "Unrecognized CSS URL syntax is unsupported.";
      }
      if (!value.startsWith('"') && !value.startsWith("'")) {
        const unescaped = value.replace(new RegExp(CSS_ESCAPE, "gi"), "");
        if (/[\s("']/.test(unescaped) || containsAsciiControlCharacter(unescaped)) {
          return "Unrecognized CSS URL syntax is unsupported.";
        }
      }
    } else if (token === "\\" || source.startsWith("/*", match.index)) {
      return "Unrecognized CSS escape or comment syntax is unsupported.";
    }
  }
  return undefined;
}

function isTemplate(
  node: DefaultTreeAdapterTypes.Element,
): node is DefaultTreeAdapterTypes.Template {
  return node.namespaceURI === html.NS.HTML && node.tagName === "template";
}

export function htmlPreviewAttribute(node: DefaultTreeAdapterTypes.Element, name: string) {
  return node.attrs.find((entry) => entry.name === name)?.value;
}

function htmlElements(document: DefaultTreeAdapterTypes.Document, allowScripts: boolean) {
  const elements: HtmlPreviewElement[] = [];
  const pending = document.childNodes.toReversed().map((node) => ({ node, inert: false }));
  while (pending.length) {
    const current = pending.pop()!;
    if (!defaultTreeAdapter.isElementNode(current.node)) {
      continue;
    }
    const node = current.node;
    elements.push({ node, inert: current.inert });
    const inert =
      current.inert ||
      isTemplate(node) ||
      (allowScripts && node.namespaceURI === html.NS.HTML && node.tagName === "noscript");
    const children = isTemplate(node) ? node.content.childNodes : node.childNodes;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      pending.push({ node: child, inert });
      if (
        allowScripts &&
        node.namespaceURI === html.NS.HTML &&
        node.tagName === "noscript" &&
        defaultTreeAdapter.isTextNode(child)
      ) {
        for (const nested of parseFragment(child.value, { scriptingEnabled: false }).childNodes) {
          pending.push({ node: nested, inert: true });
        }
      }
    }
  }
  return elements;
}

/** The existing HTML asset graph is shared by legacy inlining and server admission. */
export function collectHtmlPreviewAssets(
  source: string,
  allowScripts = true,
  options: { includeInlineCss?: boolean } = {},
): HtmlPreviewAssetSelection {
  let parseError = false;
  const document = parse(source, {
    scriptingEnabled: allowScripts,
    sourceCodeLocationInfo: true,
    onParseError: ({ code }) => {
      parseError ||= code !== ErrorCodes.missingDoctype;
    },
  });
  const elements = htmlElements(document, allowScripts);
  const policies = elements.filter(
    ({ node }) =>
      node.tagName === "meta" &&
      /^content-security-policy(?:-report-only)?$/i.test(
        htmlPreviewAttribute(node, "http-equiv")?.trim() ?? "",
      ),
  );
  let hasBaseHref = false;
  const texts: TextAssets[] = [];
  const stylesheets: ExternalElement[] = [];
  const scripts: ExternalElement[] = [];
  const requested = new Set<string>();
  const addText = (text: TextAssets) => {
    if (text.refs.length === 0) {
      return;
    }
    texts.push(text);
    for (const { ref } of text.refs) {
      requested.add(ref);
    }
  };
  for (const { node, inert } of elements) {
    if (inert) {
      continue;
    }
    const htmlElement = node.namespaceURI === html.NS.HTML;
    const attr = (name: string) => node.attrs.find((entry) => entry.name === name)?.value;
    if (htmlElement && node.tagName === "base" && attr("href") !== undefined) {
      hasBaseHref = true;
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
      let refs: HtmlPreviewReference[] = [];
      if (attribute.name === "style" && options.includeInlineCss !== false) {
        refs = htmlPreviewCssReferences(attribute.value);
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
        node,
        start: loc.startOffset,
        end: loc.endOffset,
        source: attribute.value,
        refs,
        attribute: attribute.name,
      });
    }
    if (
      options.includeInlineCss !== false &&
      node.tagName === "style" &&
      location.startTag &&
      location.endTag
    ) {
      const css = source.slice(location.startTag.endOffset, location.endTag.startOffset);
      addText({
        node,
        start: location.startTag.endOffset,
        end: location.endTag.startOffset,
        source: css,
        refs: htmlPreviewCssReferences(css),
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
  return {
    document,
    elements,
    policies,
    parseError,
    texts,
    stylesheets,
    scripts,
    refs: requested,
    hasBaseHref,
  };
}
