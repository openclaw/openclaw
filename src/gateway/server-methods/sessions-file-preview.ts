import { createHash } from "node:crypto";
import type {
  SessionsFilesAssetsResult,
  SessionsFilesPreviewParams,
  SessionsFilesPreviewResult,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { SESSIONS_FILES_ASSETS_MAX_REFS } from "../../../packages/gateway-protocol/src/session-limits.js";
import {
  createSessionFilePreviewGrant,
  releaseSessionFilePreviewGrant,
  sessionFilePreviewBinding,
} from "../artifact-download-grants.js";
import {
  analyzeSessionHtmlPreview,
  analyzeSessionHtmlPreviewCss,
  createSessionHtmlPreviewPaths,
} from "./session-html-preview.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type Asset = Extract<SessionsFilesAssetsResult["assets"][number], { content: string }>;
/** Compose the existing bounded asset reader with the existing retained-grant lifetime. */
export async function respondSessionFilePreview({
  options,
  params,
  readAssets,
  assertCurrent,
  release,
  onGrantCreated,
}: {
  options: GatewayRequestHandlerOptions;
  params: SessionsFilesPreviewParams;
  readAssets: (refs: string[]) => Promise<SessionsFilesAssetsResult>;
  assertCurrent: () => void;
  release: () => void;
  onGrantCreated: () => void;
}): Promise<void> {
  const unsupported = () => {
    assertCurrent();
    options.respond(true, {
      status: "unsupported",
      html: params.html,
      omitted: 0,
    } satisfies SessionsFilesPreviewResult);
  };
  const analysis = analyzeSessionHtmlPreview(params.html, params.allowScripts !== false);
  if (analysis.status !== "supported") {
    unsupported();
    return;
  }
  const loaded = new Map<string, Asset>();
  const omitted = new Set<string>();
  const load = async (refs: string[]) => {
    const requested = [...new Set(refs)].filter((ref) => !loaded.has(ref) && !omitted.has(ref));
    const batch = requested.slice(0, SESSIONS_FILES_ASSETS_MAX_REFS);
    for (const ref of requested.slice(SESSIONS_FILES_ASSETS_MAX_REFS)) {
      omitted.add(ref);
    }
    if (batch.length === 0) {
      return;
    }
    const result = await readAssets(batch);
    assertCurrent();
    for (const asset of result.assets) {
      if ("content" in asset) {
        loaded.set(asset.ref, asset);
      } else {
        omitted.add(asset.ref);
      }
    }
  };
  await load(analysis.plan.resources.map(({ ref }) => ref));
  const nested: string[] = [];
  for (const resource of analysis.plan.resources) {
    const asset = loaded.get(resource.ref);
    if (!asset) {
      continue;
    }
    if (
      (resource.kind === "script" && asset.mimeType !== "text/javascript") ||
      (resource.kind === "stylesheet" && asset.mimeType !== "text/css") ||
      (resource.kind === "image" && !asset.mimeType.startsWith("image/")) ||
      (resource.kind === "media" && !/^(?:audio|video)\//.test(asset.mimeType))
    ) {
      unsupported();
      return;
    }
    if (resource.kind === "stylesheet") {
      const css = analyzeSessionHtmlPreviewCss(
        Buffer.from(asset.content, "base64").toString("utf8"),
        resource.ref,
      );
      if (css.status !== "supported") {
        unsupported();
        return;
      }
      nested.push(...css.plan.resources.map(({ ref }) => ref));
    }
  }
  await load(nested);
  // CSS resources remain image/media reads; no import/font/code edge acquires a grant.
  for (const ref of nested) {
    const asset = loaded.get(ref);
    if (asset && !/^(?:image|audio|video)\//.test(asset.mimeType)) {
      unsupported();
      return;
    }
  }
  let paths: ReturnType<typeof createSessionHtmlPreviewPaths>;
  try {
    paths = createSessionHtmlPreviewPaths([
      ...analysis.plan.resources.map(({ ref }) => ref),
      ...nested,
    ]);
  } catch {
    unsupported();
    return;
  }
  if (loaded.size === 0) {
    assertCurrent();
    options.respond(true, {
      status: "ready",
      html: params.html,
      omitted: omitted.size,
    } satisfies SessionsFilesPreviewResult);
    return;
  }
  const resources = new Map<string, { ref: string; mimeType: string; digest: string }>();
  for (const [ref, asset] of loaded) {
    const path = paths.paths.get(ref)!;
    const digest = createHash("sha256").update(Buffer.from(asset.content, "base64")).digest("hex");
    const existing = resources.get(path.path);
    if (existing && (existing.digest !== digest || existing.mimeType !== asset.mimeType)) {
      unsupported();
      return;
    }
    resources.set(path.path, { ref, mimeType: asset.mimeType, digest });
  }
  assertCurrent();
  const binding = sessionFilePreviewBinding(params);
  const grant = createSessionFilePreviewGrant({
    client: options.client,
    binding,
    documentPath: paths.documentPath,
    assertCurrent,
    release,
    read: async (path) => {
      const resource = resources.get(path);
      if (!resource) {
        return undefined;
      }
      const result = await readAssets([resource.ref]);
      assertCurrent();
      const asset = result.assets[0];
      if (!asset || !("content" in asset) || asset.mimeType !== resource.mimeType) {
        return undefined;
      }
      const body = Buffer.from(asset.content, "base64");
      if (createHash("sha256").update(body).digest("hex") !== resource.digest) {
        return undefined;
      }
      return { body, mimeType: resource.mimeType };
    },
  });
  onGrantCreated();
  try {
    assertCurrent();
    options.respond(true, {
      status: "ready",
      html: params.html,
      omitted: omitted.size,
      previewId: grant.previewId,
      sandboxPath: grant.sandboxPath,
    } satisfies SessionsFilesPreviewResult);
  } catch (error) {
    releaseSessionFilePreviewGrant(options.client, grant.previewId, binding);
    throw error;
  }
}
