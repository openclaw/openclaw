import { defaultTreeAdapter, html, parse, type DefaultTreeAdapterTypes } from "parse5";

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
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      pending.push(node.childNodes[index]!);
    }
  }
  const replacements = new Map<number, { start: number; end: number; text: string }>();
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
    // HTML recovery can reconstruct several elements from the same authored start tag.
    replacements.set(location.startOffset, {
      start: location.startOffset,
      end: location.endOffset,
      text: `href="about:srcdoc${escapedHref}"`,
    });
  }
  const parts: string[] = [];
  let position = 0;
  for (const replacement of [...replacements.values()].toSorted((a, b) => a.start - b.start)) {
    parts.push(source.slice(position, replacement.start), replacement.text);
    position = replacement.end;
  }
  parts.push(source.slice(position));
  return parts.join("");
}
