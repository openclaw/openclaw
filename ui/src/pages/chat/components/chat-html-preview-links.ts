import { defaultTreeAdapter, html, parse, type DefaultTreeAdapterTypes } from "parse5";
import { applyHtmlPreviewEdits, type HtmlPreviewEdit } from "./chat-html-preview-source.ts";

/** Prepare display bytes without serializing the author's document or changing its base URL. */
export function prepareHtmlPreviewLinks(source: string, allowScripts: boolean): string {
  if (!source.includes("#") && !source.includes("&")) {
    return source;
  }
  const document = parse(source, {
    scriptingEnabled: allowScripts,
    sourceCodeLocationInfo: true,
  });
  const links: DefaultTreeAdapterTypes.Element[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = document.childNodes.toReversed();
  let baseTarget: string | undefined;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!defaultTreeAdapter.isElementNode(node)) {
      continue;
    }
    // Template contents are inert and are not in childNodes. Foreign links keep their own semantics.
    if (node.namespaceURI === html.NS.HTML) {
      if (node.tagName === "base") {
        if (node.attrs.some((attribute) => attribute.name === "href")) {
          return source;
        }
        baseTarget ??= node.attrs.find((attribute) => attribute.name === "target")?.value;
      } else if (node.tagName === "a" || node.tagName === "area") {
        links.push(node);
      }
    }
    pending.push(...node.childNodes.toReversed());
  }
  const replacements: HtmlPreviewEdit[] = [];
  for (const link of links) {
    // URL parsing ignores leading C0 controls and space, but not other Unicode whitespace.
    const authoredHref = link.attrs.find((attribute) => attribute.name === "href")?.value ?? "";
    let fragmentStart = 0;
    while (fragmentStart < authoredHref.length && authoredHref.charCodeAt(fragmentStart) <= 0x20) {
      fragmentStart += 1;
    }
    const href = authoredHref.slice(fragmentStart);
    const target = link.attrs.find((attribute) => attribute.name === "target")?.value ?? baseTarget;
    const location = link.sourceCodeLocation?.attrs?.href;
    if (
      !href.startsWith("#") ||
      !location ||
      (target && target.toLowerCase() !== "_self") ||
      link.attrs.some((attribute) => attribute.name === "download")
    ) {
      continue;
    }
    const escapedHref = href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    replacements.push({
      start: location.startOffset,
      end: location.endOffset,
      text: `href="about:srcdoc${escapedHref}"`,
    });
  }
  return applyHtmlPreviewEdits(source, replacements);
}
