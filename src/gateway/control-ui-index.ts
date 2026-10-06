import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml } from "../shared/html-escape.js";
import { escapeRegExp } from "../shared/regexp.js";
import {
  buildControlUiRootAssetPath,
  CONTROL_UI_BASE_PATH_ATTRIBUTE,
  CONTROL_UI_BUILD_ID_ATTRIBUTE,
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  CONTROL_UI_ROOT_PUBLIC_ASSETS,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  isControlUiVersionedPublicAsset,
  type ControlUiEnvironment,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader, computeInlineScriptHashes } from "./control-ui-csp.js";
import { selectControlUiRoutePreloads } from "./control-ui-route-preloads.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { sendControlUiHtmlBody } from "./control-ui-static.js";

/** Anchors bundled assets before deep-linked documents begin preloading. */
function rewriteControlUiIndexHtmlAssetHrefs(
  html: string,
  basePath: string,
  buildId?: string,
): string {
  const normalized = normalizeControlUiBasePath(basePath);
  const replacements = new Map<string, string>([
    ['src="./assets/', `src="${normalized}/assets/`],
    ['href="./assets/', `href="${normalized}/assets/`],
  ]);
  for (const asset of CONTROL_UI_ROOT_PUBLIC_ASSETS) {
    const version =
      buildId && isControlUiVersionedPublicAsset(asset) ? `?v=${encodeURIComponent(buildId)}` : "";
    const assetHref = `href="${buildControlUiRootAssetPath(normalized, asset)}${version}"`;
    // Vite's portable ./ base emits relative hrefs, which the browser starts
    // resolving against a nested route before the UI can correct them.
    replacements.set(`href="./${asset}"`, assetHref);
    replacements.set(`href="/${asset}"`, assetHref);
    replacements.set(`href="${buildControlUiRootAssetPath(normalized, asset)}"`, assetHref);
  }
  // Copy the document once instead of once per matching asset.
  const pattern = new RegExp([...replacements.keys()].map(escapeRegExp).join("|"), "g");
  return html.replace(pattern, (match) => replacements.get(match) ?? match);
}

export async function serveControlUiIndexHtml(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  uiPath: string,
  basePath?: string,
  allowWasm?: boolean,
  environment?: ControlUiEnvironment,
  buildId?: string,
  sessionEntryPath?: string,
  isSessionEntryCurrent?: () => boolean,
) {
  const normalizedBasePath = normalizeControlUiBasePath(basePath);
  const preloadRoute =
    uiPath === "/chat" || uiPath.startsWith("/chat/")
      ? "chat"
      : uiPath === "/new" || uiPath === "/new/"
        ? "new"
        : null;
  const withBasePath = rewriteControlUiIndexHtmlAssetHrefs(
    selectControlUiRoutePreloads(body, preloadRoute),
    normalizedBasePath,
    buildId,
  );
  // An empty base path is authoritative for Gateway resources even when the
  // router infers a namespace. Always emit it so resources stay root-mounted.
  const basePathAttribute = ` ${CONTROL_UI_BASE_PATH_ATTRIBUTE}="${escapeHtml(normalizedBasePath)}"`;
  const environmentAttributes = environment
    ? ` ${CONTROL_UI_ENVIRONMENT_ATTRIBUTE}="${escapeHtml(JSON.stringify(environment))}"`
    : "";
  // Let the app initialize fail-closed without guessing whether this document
  // was served with the terminal's WASM CSP allowance.
  // The lifecycle owns bundled identity. Strip the build stamp for custom roots,
  // whose files may change independently and must keep revalidating.
  const buildAttribute = buildId
    ? ` ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${escapeHtml(buildId)}"`
    : "";
  const prepared = withBasePath.replace(/<html\b[^>]*>/i, (tag) =>
    tag
      .replace(new RegExp(`\\s${CONTROL_UI_BUILD_ID_ATTRIBUTE}="[^"]*"`, "g"), "")
      .replace(
        /<html\b/i,
        `<html${basePathAttribute} ${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}="${allowWasm === true}"${environmentAttributes}${buildAttribute}`,
      ),
  );
  const document = sessionEntryPath
    ? prepared.replace(
        /<head\b[^>]*>/i,
        (tag) =>
          `${tag}<script>history.replaceState(null,"",${JSON.stringify(sessionEntryPath).replaceAll("<", "\\u003c")}+location.hash);</script>`,
      )
    : prepared;
  const hashes = computeInlineScriptHashes(document);
  // Always set the document CSP here (the index carries inline scripts) so the
  // terminal's WASM relaxation is applied to the page that loads ghostty-web.
  res.setHeader(
    "Content-Security-Policy",
    buildControlUiCspHeader({
      inlineScriptHashes: hashes,
      allowWasm,
      portalHost: req.headers.host,
    }),
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", sessionEntryPath ? "no-store" : "no-cache");
  await sendControlUiHtmlBody(req, res, document, isSessionEntryCurrent);
}
