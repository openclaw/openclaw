import type { SessionsFilesAssetsResult } from "@openclaw/gateway-protocol";
import type { DefaultTreeAdapterTypes } from "parse5";
import { SESSIONS_FILES_ASSETS_MAX_REFS } from "../../../../../packages/gateway-protocol/src/session-limits.js";
import {
  collectHtmlPreviewAssets,
  htmlPreviewCssReferences,
  type HtmlPreviewReference as Reference,
} from "../../../../../src/shared/html-preview-assets.js";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import { applyHtmlPreviewEdits, type HtmlPreviewEdit } from "./chat-html-preview-source.ts";

type Asset = SessionsFilesAssetsResult["assets"][number];
type LoadedAsset = Extract<Asset, { content: string }>;

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

export function inspectHtmlPreviewSource(source: string, allowScripts = true) {
  const { policies, refs } = collectHtmlPreviewAssets(source, allowScripts);
  return { hasAuthoredCsp: policies.length > 0, hasRelativeAssets: refs.size > 0 };
}

/** Authored CSP uses native resource admission; ordinary documents retain asset inlining. */
export async function prepareHtmlPreviewAssets(
  source: string,
  allowScripts: boolean,
  fetchAssets?: (refs: string[]) => Promise<SessionsFilesAssetsResult>,
): Promise<{ html: string; omitted: number }> {
  const selection = collectHtmlPreviewAssets(source, allowScripts);
  if (selection.policies.length || selection.hasBaseHref || !fetchAssets) {
    return { html: source, omitted: 0 };
  }
  const { texts, stylesheets, scripts, refs: requested } = selection;
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
    const refs = htmlPreviewCssReferences(css, ref);
    cssByRef.set(ref, { source: css, refs });
    for (const nestedRef of refs) {
      nested.add(nestedRef.ref);
    }
  }
  await fetch(nested);
  const inline = (text: string, refs: Reference[], css: boolean) =>
    applyHtmlPreviewEdits(
      text,
      refs.flatMap((ref) => {
        const asset = loaded.get(ref.ref);
        const url = asset && dataUrl(asset, ref.ref);
        return url
          ? [{ start: ref.start, end: ref.end, text: css ? `url(${JSON.stringify(url)})` : url }]
          : [];
      }),
    );
  const edits: HtmlPreviewEdit[] = texts.flatMap((text) => {
    const content = inline(text.source, text.refs, !text.attribute || text.attribute === "style");
    return content === text.source
      ? []
      : [
          {
            start: text.start,
            end: text.end,
            text: text.attribute
              ? `${text.attribute}="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`
              : content,
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
  return { html: applyHtmlPreviewEdits(source, edits), omitted: omitted.size };
}
