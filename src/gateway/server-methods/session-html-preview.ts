import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { html } from "parse5";
import {
  SESSIONS_FILES_ASSETS_MAX_REFS,
  SESSIONS_FILES_ASSET_REF_MAX_CHARS,
} from "../../../packages/gateway-protocol/src/session-limits.js";
import {
  collectHtmlPreviewAssets,
  htmlPreviewCssReferences,
  htmlPreviewCssUnsupportedReason,
  htmlPreviewAttribute as attribute,
} from "../../shared/html-preview-assets.js";

type ResourceKind = "stylesheet" | "script" | "image" | "media";
type SessionHtmlPreviewResource = { ref: string; kind: ResourceKind };
type SessionHtmlPreviewPlan = { resources: SessionHtmlPreviewResource[] };
type Supported = { status: "supported"; plan: SessionHtmlPreviewPlan };
type Unsupported = { status: "unsupported"; reason: string };

const REQUIRED_POLICY = new Map([
  ["default-src", "'none'"],
  ["script-src", "'self'"],
  ["style-src", "'self'"],
  ["connect-src", "'none'"],
  ["font-src", "'none'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
]);

class UnsupportedPreview extends Error {}

function reject(reason: string): never {
  throw new UnsupportedPreview(reason);
}

function recognizePolicy(content: string): void {
  const seen = new Set<string>();
  for (const declaration of content.toLowerCase().split(";")) {
    const tokens = declaration.split(/[\t\n\f\r ]+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }
    const [name, ...values] = tokens;
    if (seen.has(name!)) {
      reject("Duplicate CSP directives are unsupported.");
    }
    seen.add(name!);
    const required = REQUIRED_POLICY.get(name!);
    if (
      required
        ? values.length !== 1 || values[0] !== required
        : !["img-src", "media-src"].includes(name!) ||
          !["'none'", "'self'", "'self' data:", "data: 'self'"].includes(values.join(" "))
    ) {
      reject("The authored CSP is outside the supported self-only subset.");
    }
  }
  if ([...REQUIRED_POLICY.keys()].some((name) => !seen.has(name))) {
    reject("The authored CSP is missing a required declaration.");
  }
}

/** Original HTML and CSS resolve from this synthetic document location without edits. */
export function createSessionHtmlPreviewPaths(refs: Iterable<string>): {
  paths: Map<string, { path: string; fragment: string }>;
  documentPath: string;
} {
  const unique = [...new Set(refs)];
  if (unique.length > SESSIONS_FILES_ASSETS_MAX_REFS) {
    reject("The preview exceeds the relative resource limit.");
  }
  let parents = 0;
  const components = new Set<string>();
  for (const ref of unique) {
    if (
      !ref ||
      ref.length > SESSIONS_FILES_ASSET_REF_MAX_CHARS ||
      ref.trim() !== ref ||
      /^(?:[a-z][a-z\d+.-]*:|[/\\#?~])/i.test(ref) ||
      containsAsciiControlCharacter(ref) ||
      ref.includes("\\")
    ) {
      reject("A relative resource URL has ambiguous normalization.");
    }
    let depth = 0;
    const parts = ref.split(/[?#]/, 1)[0]!.split("/");
    for (const raw of parts) {
      let part: string;
      try {
        part = decodeURIComponent(raw);
      } catch {
        reject("A relative resource URL has an invalid escape.");
      }
      if (
        !part ||
        containsAsciiControlCharacter(part) ||
        /[/%\\?#]/.test(part) ||
        (part !== raw && [".", ".."].includes(part))
      ) {
        reject("A relative resource URL has ambiguous normalization.");
      }
      components.add(part);
      depth += part === ".." ? -1 : part === "." ? 0 : 1;
      parents = Math.max(parents, -depth);
    }
    if ([".", ".."].includes(parts.at(-1)!)) {
      reject("A relative resource URL does not name a file.");
    }
  }
  let directory = "v0";
  for (let index = 1; components.has(directory); index += 1) {
    directory = `v${index}`;
  }
  let file = "preview.html";
  for (let index = 1; components.has(file); index += 1) {
    file = `preview${index}.html`;
  }
  const documentPath = `${`${directory}/`.repeat(parents)}${file}`;
  if (documentPath.length > SESSIONS_FILES_ASSET_REF_MAX_CHARS) {
    reject("The preview resource directory exceeds the URL limit.");
  }
  const base = `https://preview.invalid/${documentPath}`;
  const paths = new Map<string, { path: string; fragment: string }>();
  for (const ref of unique) {
    const url = new URL(ref, base);
    const path = url.pathname.slice(1) + url.search;
    if (path.length > SESSIONS_FILES_ASSET_REF_MAX_CHARS) {
      reject("The preview resource URL exceeds the URL limit.");
    }
    paths.set(ref, { path, fragment: url.hash });
  }
  return { paths, documentPath };
}

/** This is a closed declaration check; native browser CSP still owns every decision. */
export function analyzeSessionHtmlPreview(
  source: string,
  allowScripts = true,
): { status: "no-policy" } | Unsupported | Supported {
  try {
    // The admitted policy forbids inline CSS, so no inline resource graph is needed.
    const selection = collectHtmlPreviewAssets(source, allowScripts, { includeInlineCss: false });
    if (!selection.policies.length) {
      return { status: "no-policy" };
    }
    const policy = selection.policies[0]!;
    const head = selection.elements.find(({ node }) => node.tagName === "head")?.node;
    if (
      selection.parseError ||
      selection.policies.length !== 1 ||
      policy.inert ||
      policy.node.namespaceURI !== html.NS.HTML ||
      policy.node.parentNode !== head ||
      !head?.sourceCodeLocation?.startTag ||
      !head.sourceCodeLocation.endTag ||
      attribute(policy.node, "http-equiv")?.toLowerCase() !== "content-security-policy"
    ) {
      reject("The preview requires one unambiguous CSP in the HTML head.");
    }
    recognizePolicy(attribute(policy.node, "content") ?? "");
    const policyEnd = policy.node.sourceCodeLocation?.endOffset;
    if (policyEnd === undefined) {
      reject("The authored CSP has no unambiguous source location.");
    }
    for (const { node, inert } of selection.elements) {
      if (node.tagName === "base" && attribute(node, "href") !== undefined) {
        reject("An authored base URL is unsupported.");
      }
      if (inert) {
        continue;
      }
      const resourceBearing = node.attrs.some(({ name }) =>
        ["src", "srcset", "href", "poster"].includes(name),
      );
      if (
        (node.sourceCodeLocation?.startOffset ?? Infinity) < policyEnd &&
        node !== policy.node &&
        (resourceBearing || ["script", "style"].includes(node.tagName))
      ) {
        reject("The authored CSP must precede resource-bearing elements and scripts.");
      }
      if (
        node.tagName === "script" &&
        attribute(node, "src") !== undefined &&
        attribute(node, "type")?.trim().toLowerCase() === "module"
      ) {
        reject("External modules are unsupported by relative-resource preview.");
      }
      if (
        resourceBearing &&
        ["crossorigin", "integrity"].some((name) => attribute(node, name) !== undefined)
      ) {
        reject("Integrity and crossorigin resource attributes are unsupported.");
      }
    }
    const resources = new Map<string, SessionHtmlPreviewResource>();
    const add = (ref: string, kind: ResourceKind) => {
      const previous = resources.get(ref)?.kind;
      if (
        previous &&
        previous !== kind &&
        [previous, kind].some((value) => value === "script" || value === "stylesheet")
      ) {
        reject("A resource is used in incompatible loading contexts.");
      }
      resources.set(ref, { ref, kind });
    };
    for (const text of selection.texts) {
      if (text.attribute === "style" || text.node.tagName === "style") {
        continue;
      }
      const kind =
        text.attribute === "src" && ["source", "video", "audio"].includes(text.node.tagName)
          ? "media"
          : "image";
      for (const { ref } of text.refs) {
        add(ref, kind);
      }
    }
    for (const { ref } of selection.stylesheets) {
      add(ref, "stylesheet");
    }
    for (const { ref } of selection.scripts) {
      add(ref, "script");
    }
    createSessionHtmlPreviewPaths(resources.keys());
    return { status: "supported", plan: { resources: [...resources.values()] } };
  } catch (error) {
    if (error instanceof UnsupportedPreview) {
      return { status: "unsupported", reason: error.message };
    }
    throw error;
  }
}

export function analyzeSessionHtmlPreviewCss(
  source: string,
  stylesheetRef: string,
): Unsupported | Supported {
  const unsupportedReason = htmlPreviewCssUnsupportedReason(source);
  if (unsupportedReason) {
    return { status: "unsupported", reason: unsupportedReason };
  }
  const refs = [...new Set(htmlPreviewCssReferences(source, stylesheetRef).map(({ ref }) => ref))];
  try {
    createSessionHtmlPreviewPaths(refs);
    return {
      status: "supported",
      plan: { resources: refs.map((ref) => ({ ref, kind: "image" })) },
    };
  } catch (error) {
    if (error instanceof UnsupportedPreview) {
      return { status: "unsupported", reason: error.message };
    }
    throw error;
  }
}
