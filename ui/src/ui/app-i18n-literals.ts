import { hasLiteralTranslations, translateLiteral } from "../i18n/index.ts";

const SKIP_TEXT_TAGS = new Set([
  "CODE",
  "PRE",
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "OPTION",
]);

function shouldSkipElement(el: Element | null): boolean {
  if (!el) {
    return true;
  }
  if (SKIP_TEXT_TAGS.has(el.tagName)) {
    return true;
  }
  if (el.closest("[data-i18n-literal-ignore]")) {
    return true;
  }
  if (el.classList.contains("mono") || el.closest(".mono")) {
    return true;
  }
  return false;
}

function translateTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (shouldSkipElement(parent)) {
    return false;
  }
  const raw = node.data;
  if (!raw.trim()) {
    return false;
  }
  const leading = raw.match(/^\s*/)?.[0] ?? "";
  const trailing = raw.match(/\s*$/)?.[0] ?? "";
  const core = raw.slice(leading.length, raw.length - trailing.length);
  const translated = translateLiteral(core);
  if (!translated || translated === core) {
    return false;
  }
  node.data = `${leading}${translated}${trailing}`;
  return true;
}

function translateAttributeValue(
  el: Element,
  attr: "title" | "placeholder" | "aria-label",
): boolean {
  if (shouldSkipElement(el)) {
    return false;
  }
  const value = el.getAttribute(attr);
  if (!value) {
    return false;
  }
  const translated = translateLiteral(value);
  if (!translated || translated === value) {
    return false;
  }
  el.setAttribute(attr, translated);
  return true;
}

export function applyLiteralTranslations(root: ParentNode) {
  if (!hasLiteralTranslations()) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.nextNode();
  while (current) {
    translateTextNode(current as Text);
    current = walker.nextNode();
  }

  if (!(root instanceof Element || root instanceof DocumentFragment || root instanceof Document)) {
    return;
  }
  const elements = root.querySelectorAll("*");
  for (const el of elements) {
    translateAttributeValue(el, "title");
    translateAttributeValue(el, "placeholder");
    translateAttributeValue(el, "aria-label");
  }
}
