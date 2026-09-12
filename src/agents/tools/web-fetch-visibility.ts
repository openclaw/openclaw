/**
 * HTML visibility sanitizers for web_fetch.
 *
 * Removes hidden or invisible content before readable-text extraction.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  readRawTextBounds,
  isAsciiWhitespace,
  readTagToken,
  skipHtmlComment,
  startsLikeHtmlTag,
} from "../../../packages/markdown-core/src/html-scanner.js";

// Compile property matchers once: this list is checked for every styled element.
const HIDDEN_STYLE_PATTERNS = (
  [
    ["display", /^\s*none\s*$/i],
    ["visibility", /^\s*hidden\s*$/i],
    ["opacity", /^\s*0\s*$/],
    ["font-size", /^\s*0(px|em|rem|pt|%)?\s*$/i],
    ["text-indent", /^\s*-\d{4,}px\s*$/],
    ["color", /^\s*transparent\s*$/i],
    ["color", /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
    ["color", /^\s*hsla\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
  ] satisfies Array<[string, RegExp]>
).map(([prop, valuePattern]) => {
  const escapedProp = prop.replace(/-/g, "\\-");
  return [new RegExp(`(?:^|;)\\s*${escapedProp}\\s*:\\s*([^;]+)`, "i"), valuePattern] as const;
});

// Class names associated with visually hidden content
const HIDDEN_CLASS_NAMES = new Set([
  "sr-only",
  "visually-hidden",
  "d-none",
  "hidden",
  "invisible",
  "screen-reader-only",
  "offscreen",
]);
const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function hasHiddenClass(className: string): boolean {
  const classes = normalizeLowercaseStringOrEmpty(className).split(/\s+/);
  return classes.some((cls) => HIDDEN_CLASS_NAMES.has(cls));
}

function isStyleHidden(style: string): boolean {
  for (const [propertyPattern, valuePattern] of HIDDEN_STYLE_PATTERNS) {
    const match = style.match(propertyPattern);
    const value = match?.at(1);
    if (value && valuePattern.test(value)) {
      return true;
    }
  }

  // clip-path: none is not hidden, but positive percentage inset() clipping hides content.
  const clipPath = style.match(/(?:^|;)\s*clip-path\s*:\s*([^;]+)/i);
  const clipPathValue = clipPath?.at(1);
  if (clipPathValue && !/^\s*none\s*$/i.test(clipPathValue)) {
    if (/inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i.test(clipPathValue)) {
      return true;
    }
  }

  // transform: scale(0)
  const transform = style.match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i);
  const transformValue = transform?.at(1);
  if (transformValue) {
    if (/scale\s*\(\s*0\s*\)/i.test(transformValue)) {
      return true;
    }
    if (/translateX\s*\(\s*-\d{4,}px\s*\)/i.test(transformValue)) {
      return true;
    }
    if (/translateY\s*\(\s*-\d{4,}px\s*\)/i.test(transformValue)) {
      return true;
    }
  }

  // width:0 + height:0 + overflow:hidden
  const width = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
  const height = style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i);
  const overflow = style.match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/i);
  if (
    width &&
    /^\s*0(px)?\s*$/i.test(width.at(1) ?? "") &&
    height &&
    /^\s*0(px)?\s*$/i.test(height.at(1) ?? "") &&
    overflow &&
    /^\s*hidden\s*$/i.test(overflow.at(1) ?? "")
  ) {
    return true;
  }

  // Offscreen positioning: left/top far negative
  const left = style.match(/(?:^|;)\s*left\s*:\s*([^;]+)/i);
  const top = style.match(/(?:^|;)\s*top\s*:\s*([^;]+)/i);
  if (left && /^\s*-\d{4,}px\s*$/i.test(left.at(1) ?? "")) {
    return true;
  }
  if (top && /^\s*-\d{4,}px\s*$/i.test(top.at(1) ?? "")) {
    return true;
  }

  return false;
}

// Consume complete attributes so quoted values and framework names cannot become visibility names.
function createAttributeReader(
  attribute: "aria-hidden" | "class" | "hidden" | "style" | "type" | "encoding",
) {
  return (attrs: string): string | undefined => {
    let pos = 0;
    while (pos < attrs.length) {
      while (
        pos < attrs.length &&
        (isAsciiWhitespace(attrs.charAt(pos)) || attrs.charAt(pos) === "/")
      ) {
        pos += 1;
      }
      const nameStart = pos;
      // A leading equals sign is part of a malformed name, not a new value boundary.
      if (attrs.charAt(pos) === "=") {
        pos += 1;
      }
      while (
        pos < attrs.length &&
        !isAsciiWhitespace(attrs.charAt(pos)) &&
        attrs.charAt(pos) !== "/" &&
        attrs.charAt(pos) !== "="
      ) {
        pos += 1;
      }
      if (pos === nameStart) {
        break;
      }
      const name = attrs.slice(nameStart, pos).toLowerCase();
      while (pos < attrs.length && isAsciiWhitespace(attrs.charAt(pos))) {
        pos += 1;
      }
      let value = "";
      if (attrs.charAt(pos) === "=") {
        pos += 1;
        while (pos < attrs.length && isAsciiWhitespace(attrs.charAt(pos))) {
          pos += 1;
        }
        const quote = attrs.charAt(pos);
        if (quote === '"' || quote === "'") {
          const valueStart = pos + 1;
          const valueEnd = attrs.indexOf(quote, valueStart);
          value = valueEnd === -1 ? attrs.slice(valueStart) : attrs.slice(valueStart, valueEnd);
          pos = valueEnd === -1 ? attrs.length : valueEnd + 1;
        } else {
          const valueStart = pos;
          while (pos < attrs.length && !isAsciiWhitespace(attrs.charAt(pos))) {
            pos += 1;
          }
          value = attrs.slice(valueStart, pos);
        }
      }
      if (name === attribute) {
        return value;
      }
    }
    return undefined;
  };
}

const readType = createAttributeReader("type");
const readAriaHidden = createAttributeReader("aria-hidden");
const readHidden = createAttributeReader("hidden");
const readClass = createAttributeReader("class");
const readStyle = createAttributeReader("style");
const readEncoding = createAttributeReader("encoding");

function shouldRemoveElement(tagName: string, attrs: string): boolean {
  if (["meta", "template", "svg", "canvas", "iframe", "object", "embed"].includes(tagName)) {
    return true;
  }

  if (tagName === "input" && normalizeOptionalLowercaseString(readType(attrs)) === "hidden") {
    return true;
  }

  if (normalizeOptionalLowercaseString(readAriaHidden(attrs)) === "true") {
    return true;
  }

  if (readHidden(attrs) !== undefined) {
    return true;
  }

  const className = readClass(attrs) ?? "";
  if (hasHiddenClass(className)) {
    return true;
  }

  const style = readStyle(attrs) ?? "";
  if (style && isStyleHidden(style)) {
    return true;
  }

  return false;
}

const LIST_CONTAINERS = new Set(["ul", "ol", "menu"]);
const OPAQUE_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);
const MATH_TEXT_INTEGRATION_POINTS = new Set(["mi", "mo", "mn", "ms", "mtext"]);
const SVG_HTML_INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title"]);
// HTML's li start-tag rule stops at special elements other than address, div, and p.
// Foreign-content containers also retain scope; void elements never enter the stack.
const LIST_ITEM_BOUNDARIES = new Set([
  "applet",
  "article",
  "aside",
  "blockquote",
  "body",
  "button",
  "caption",
  "center",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "html",
  "iframe",
  "listing",
  "main",
  "marquee",
  "math",
  "menu",
  "nav",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "plaintext",
  "pre",
  "script",
  "search",
  "section",
  "select",
  "style",
  "summary",
  "svg",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "ul",
  "xmp",
]);

const DEFINITION_ITEMS = new Set(["dt", "dd"]);
const LIST_ITEMS = new Set(["li"]);
const DEFINITION_CONTAINERS = new Set(["dl"]);
const PARAGRAPH_CLOSE_START = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "listing",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "plaintext",
  "pre",
  "search",
  "section",
  "table",
  "ul",
  "xmp",
]);
const BUTTON_SCOPE_BOUNDARIES = new Set([
  "applet",
  "button",
  "caption",
  "html",
  "marquee",
  "math",
  "object",
  "svg",
  "table",
  "td",
  "template",
  "th",
]);
const TABLE_SCOPE_BOUNDARIES = new Set(["html", "math", "svg", "table", "template"]);
const PARAGRAPH_REQUIRED_END_PARENTS = new Set([
  "a",
  "audio",
  "del",
  "ins",
  "map",
  "noscript",
  "video",
]);
const ROW_GROUPS = new Set(["tbody", "thead", "tfoot"]);

type OpenElement = {
  name: string;
  previousSameName: number | undefined;
  special: number;
  buttonBoundary: number;
  tableBoundary: number;
  selectOwner: number;
  namespace: "html" | "math" | "svg";
  childNamespace: "html" | "math" | "svg";
};

function removeMarkedElements(html: string): string {
  let output = "";
  let cursor = 0;
  // Scope facts belong to each open frame and restore when it closes. Indexed names
  // avoid rescanning unchanged ancestry for malformed closers or repeated siblings.
  const elements: OpenElement[] = [
    {
      name: "",
      previousSameName: undefined,
      special: 0,
      buttonBoundary: 0,
      tableBoundary: 0,
      selectOwner: -1,
      namespace: "html",
      childNamespace: "html",
    },
  ];
  const positions = new Map<string, number>();
  let hiddenRoot = -1;

  function closeElements(index: number): void {
    while (elements.length > index) {
      const element = elements.pop()!;
      if (element.previousSameName === undefined) {
        positions.delete(element.name);
      } else {
        positions.set(element.name, element.previousSameName);
      }
    }
  }

  function closeOptionalElement(index: number): void {
    // Recovery cannot close a genuinely unclosed, non-optional hidden descendant.
    if (
      index > 0 &&
      elements[index]!.namespace === "html" &&
      (hiddenRoot < 0 || hiddenRoot <= index)
    ) {
      closeElements(index);
      if (hiddenRoot === index) {
        hiddenRoot = -1;
      }
    }
  }

  function lastOpen(names: readonly string[]): number {
    let index = -1;
    for (const name of names) {
      const position = positions.get(name);
      if (position !== undefined && position > index) {
        index = position;
      }
    }
    return index;
  }

  function scopedItem(items: Set<string>, owners: Set<string>): number {
    const index = elements.at(-1)!.special;
    if (index > 0 && items.has(elements[index]!.name)) {
      const owner = elements[index - 1]!.special;
      if (owners.has(elements[owner]!.name)) {
        return index;
      }
    }
    return -1;
  }

  function paragraph(): number {
    const index = positions.get("p");
    return index !== undefined && index > elements.at(-1)!.buttonBoundary ? index : -1;
  }

  function tableScope() {
    const table = elements.at(-1)!.tableBoundary;
    const owner = elements[table]!.name === "table" ? table : -1;
    const group = lastOpen(["tbody", "thead", "tfoot"]);
    const row = lastOpen(["tr"]);
    const cell = lastOpen(["td", "th"]);
    return {
      owner,
      group: owner >= 0 && group > owner ? group : owner,
      row: owner >= 0 && row > owner ? row : -1,
      cell: owner >= 0 && row > owner && cell > row ? cell : -1,
    };
  }

  function optionScope() {
    const owner = elements.at(-1)!.selectOwner;
    const group = lastOpen(["optgroup"]);
    const option = lastOpen(["option"]);
    return {
      owner,
      group: owner >= 0 && group > owner ? group : -1,
      option: owner >= 0 && option > owner ? option : -1,
    };
  }

  function closesOptionalElement(element: number, index: number): boolean {
    if (element <= 0 || index >= element || elements[element]!.namespace !== "html") {
      return false;
    }
    const name = elements[element]!.name;
    if (name === "li" || DEFINITION_ITEMS.has(name)) {
      const item =
        name === "li"
          ? scopedItem(LIST_ITEMS, LIST_CONTAINERS)
          : scopedItem(DEFINITION_ITEMS, DEFINITION_CONTAINERS);
      return item === element && elements[element - 1]!.special === index;
    }
    if (name === "p") {
      const parent = elements[element - 1]!.name;
      return (
        paragraph() === element &&
        !PARAGRAPH_REQUIRED_END_PARENTS.has(parent) &&
        !parent.includes("-") &&
        (index === element - 1 || closesOptionalElement(element - 1, index))
      );
    }
    if (name === "td" || name === "th" || name === "tr" || ROW_GROUPS.has(name)) {
      const scope = tableScope();
      if (name === "td" || name === "th") {
        return scope.cell === element && [scope.row, scope.group, scope.owner].includes(index);
      }
      if (name === "tr") {
        return scope.row === element && [scope.group, scope.owner].includes(index);
      }
      return scope.group === element && index === scope.owner;
    }
    if (name === "option" || name === "optgroup") {
      const scope = optionScope();
      return name === "option"
        ? scope.option === element && [scope.group, scope.owner].includes(index)
        : scope.group === element && index === scope.owner;
    }
    return false;
  }

  function closeForStart(name: string): void {
    if (PARAGRAPH_CLOSE_START.has(name)) {
      closeOptionalElement(paragraph());
    }
    if (name === "li") {
      closeOptionalElement(scopedItem(LIST_ITEMS, LIST_CONTAINERS));
    } else if (DEFINITION_ITEMS.has(name)) {
      closeOptionalElement(scopedItem(DEFINITION_ITEMS, DEFINITION_CONTAINERS));
    } else if (name === "td" || name === "th" || name === "tr" || ROW_GROUPS.has(name)) {
      if (tableScope().cell > 0) {
        closeOptionalElement(paragraph());
      }
      closeOptionalElement(tableScope().cell);
      if (name === "tr" || ROW_GROUPS.has(name)) {
        closeOptionalElement(tableScope().row);
      }
      if (ROW_GROUPS.has(name)) {
        const scope = tableScope();
        if (scope.group > scope.owner) {
          closeOptionalElement(scope.group);
        }
      }
    } else if (name === "option" || name === "optgroup") {
      const scope = optionScope();
      const inSelect = scope.owner >= 0 && elements[scope.owner]!.name === "select";
      // Body-mode datalist parsing only closes an option that is the current node.
      if (inSelect || elements.at(-1)!.name === "option") {
        closeOptionalElement(scope.option);
      }
      if (name === "optgroup" && inSelect) {
        closeOptionalElement(scope.group);
      }
    }
  }

  function openElement(name: string, attrs: string, namespace: OpenElement["namespace"]): void {
    const parent = elements.at(-1)!;
    const index = elements.length;
    const foreign = name === "math" || name === "svg";
    const encoding =
      namespace === "math" && name === "annotation-xml"
        ? readEncoding(attrs)?.toLowerCase()
        : undefined;
    const htmlChildren =
      (namespace === "math" &&
        (MATH_TEXT_INTEGRATION_POINTS.has(name) ||
          encoding === "text/html" ||
          encoding === "application/xhtml+xml")) ||
      (namespace === "svg" && SVG_HTML_INTEGRATION_POINTS.has(name));
    elements.push({
      name,
      previousSameName: positions.get(name),
      special: name === "li" || LIST_ITEM_BOUNDARIES.has(name) ? index : parent.special,
      buttonBoundary: BUTTON_SCOPE_BOUNDARIES.has(name) ? index : parent.buttonBoundary,
      tableBoundary: TABLE_SCOPE_BOUNDARIES.has(name) ? index : parent.tableBoundary,
      selectOwner:
        name === "select" || name === "datalist"
          ? index
          : foreign || name === "html" || name === "template"
            ? -1
            : parent.selectOwner,
      namespace,
      childNamespace: htmlChildren ? "html" : namespace,
    });
    positions.set(name, index);
  }

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      if (hiddenRoot < 0) {
        output += html.slice(cursor);
      }
      break;
    }

    if (hiddenRoot < 0) {
      output += html.slice(cursor, tagStart);
    }

    if (html.startsWith("<!--", tagStart)) {
      cursor = skipHtmlComment(html, tagStart);
      continue;
    }

    if (!startsLikeHtmlTag(html, tagStart)) {
      if (hiddenRoot < 0) {
        output += "<";
      }
      cursor = tagStart + 1;
      continue;
    }

    const read = readTagToken(html, tagStart, "visibility");
    if (!read) {
      if (hiddenRoot < 0) {
        output += html.slice(tagStart);
      }
      break;
    }

    const token = html.slice(tagStart, read.next);
    const parsed = read.token;
    if (!parsed) {
      if (hiddenRoot < 0) {
        output += token;
      }
      cursor = read.next;
      continue;
    }

    const parent = elements.at(-1)!;
    let namespace = parent.childNamespace;
    if (
      parent.namespace === "math" &&
      MATH_TEXT_INTEGRATION_POINTS.has(parent.name) &&
      (parsed.name === "mglyph" || parsed.name === "malignmark")
    ) {
      namespace = "math";
    } else if (namespace === "html" && (parsed.name === "math" || parsed.name === "svg")) {
      namespace = parsed.name;
    }
    if (!parsed.closing && namespace === "html" && OPAQUE_TEXT_ELEMENTS.has(parsed.name)) {
      closeForStart(parsed.name);
      const bounds =
        parsed.name === "plaintext"
          ? { contentEnd: html.length, end: html.length }
          : readRawTextBounds(html, parsed.name, read.next, "visibility");
      if (hiddenRoot < 0 && !shouldRemoveElement(parsed.name, parsed.attrs)) {
        // Readability's DOM parser does not recognize double-escaped script data.
        // Empty comments preserve token boundaries without retaining their hidden text.
        output +=
          parsed.name === "script"
            ? token +
              html
                .slice(read.next, bounds.contentEnd)
                .replace(/<!--[\s\S]*?(?:-->|$)/g, "<!---->") +
              html.slice(bounds.contentEnd, bounds.end)
            : html.slice(tagStart, bounds.end);
      }
      cursor = bounds.end;
      continue;
    }

    if (parsed.closing) {
      const index = positions.get(parsed.name);
      const visible = hiddenRoot < 0;
      const closesHiddenOptional = index !== undefined && closesOptionalElement(hiddenRoot, index);
      if (index !== undefined && (visible || index >= hiddenRoot || closesHiddenOptional)) {
        closeElements(index);
        if (hiddenRoot >= index) {
          hiddenRoot = -1;
        }
      }
      if (visible || closesHiddenOptional) {
        output += token;
      }
    } else {
      if (namespace === "html") {
        closeForStart(parsed.name);
      }
      const hidden = hiddenRoot >= 0 || shouldRemoveElement(parsed.name, parsed.attrs);
      if (!hidden) {
        output += token;
      }
      if (!parsed.selfClosing && !HTML_VOID_ELEMENTS.has(parsed.name)) {
        if (hidden && hiddenRoot < 0) {
          hiddenRoot = elements.length;
        }
        openElement(parsed.name, parsed.attrs, namespace);
      }
    }
    cursor = read.next;
  }

  return output;
}

export async function sanitizeHtml(html: string): Promise<string> {
  return removeMarkedElements(html);
}
