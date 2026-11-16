import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isWithinDir } from "@openclaw/fs-safe/path";
import { isControlUiFocusPath } from "@openclaw/session-url-contract";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAvatarMime } from "../shared/avatar-policy.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  controlUiAvatarResolutionMeta,
  type ControlUiAvatarMeta,
  gatewayAssistantAvatarUrl,
  prepareGatewayAssistantAvatar,
} from "./assistant-avatar.js";
import { resolveAssistantIdentityAvatar } from "./assistant-identity.js";
import { matchesControlUiBootstrapConfigPath } from "./control-ui-bootstrap-contract.js";
import { prepareControlUiBootstrapConfig } from "./control-ui-bootstrap.js";
import {
  isControlUiRootPublicAsset,
  isImmutableControlUiPublicAsset,
  parseControlUiResourcePath,
} from "./control-ui-contract.js";
import { applyControlUiSecurityHeaders } from "./control-ui-csp.js";
import { startControlUiDocumentDiagnostics } from "./control-ui-document-diagnostics.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  sendControlUiJson,
} from "./control-ui-http-utils.js";
import { serveControlUiIndexHtml } from "./control-ui-index.js";
import { classifyControlUiRequest, isControlUiApprovalDocumentPath } from "./control-ui-routing.js";
import { isControlUiSharePath, serveControlUiShareDocument } from "./control-ui-share.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  isControlUiStaticAssetExtension,
  resolveControlUiAssetEncodings,
  resolveControlUiHtmlEncoding,
  respondControlUiStaticAsset,
  respondControlUiAssetsUnavailable,
  respondControlUiNotAcceptable,
  respondHeadForControlUiFile,
} from "./control-ui-static.js";
import { authorizeControlUiReadRequestOrReply } from "./http-auth-utils.js";
import { sendHttpImageResponse } from "./http-image-response.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { getRemoteControlUiIngressContext } from "./ingress-attribution.js";
import { readControlUiRootAsset, type ControlUiRootState } from "./server-control-ui-root.js";
import { isTerminalConfigEnabled } from "./terminal/enabled.js";

const ROOT_PREFIX = "/";
const loadAvatarThumbnail = createLazyRuntimeModule(
  () => import("./assistant-avatar-thumbnail.runtime.js"),
);

type ControlUiRequestOptions = Partial<GatewayHttpRequestAuthOptions> & {
  basePath?: string;
  config?: OpenClawConfig;
  terminalEnabled?: boolean;
  agentId?: string;
  root?: ControlUiRootState;
  /** Protected session-entry restores the canonical route before any app script runs. */
  sessionEntryPath?: string;
  isSessionEntryCurrent?: () => boolean;
  /** Startup owns the asset-free recovery document; static serving detects missing bytes. */
  onUnavailableDocument?: () => boolean;
};

const CONTROL_UI_NAMESPACE_PREFIX = "/__openclaw__/";

function isValidAgentPathSegment(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export async function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: Partial<GatewayHttpRequestAuthOptions> & {
    basePath?: string;
    config: OpenClawConfig;
  },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw || !isReadHttpMethod(req.method)) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const parsed = parseControlUiResourcePath("agentAvatar", pathname, basePath);
  if (!parsed.matched) {
    return false;
  }

  applyControlUiSecurityHeaders(res, getRemoteControlUiIngressContext(req));
  const agentId = parsed.value;
  if (!agentId || !isValidAgentPathSegment(agentId)) {
    respondControlUiNotFound(res);
    return true;
  }

  // Avatar bytes are the image behind agent.identity.get's avatar URL, so they
  // share its session-read authority instead of assistant media file access.
  const requestAuth = await authorizeControlUiReadRequestOrReply({
    ...opts,
    req,
    res,
    cfg: opts.cfg ?? opts.config,
    requiredOperatorMethod: "agent.identity.get",
  });
  if (!requestAuth) {
    return true;
  }
  requestAuth.assertCurrent();

  try {
    const identity = await resolveAssistantIdentityAvatar({ cfg: opts.config, agentId });
    const projection = await prepareGatewayAssistantAvatar({
      cfg: opts.config,
      identity,
      readBody:
        url.searchParams.get("meta") !== "1" &&
        (req.method !== "HEAD" || url.searchParams.has("v")),
    });
    requestAuth.assertCurrent();
    const resolved = projection.resolution;
    if (url.searchParams.get("meta") === "1") {
      const avatarUrl =
        gatewayAssistantAvatarUrl(projection, basePath, agentId) ??
        (resolved?.kind === "remote" ? resolved.url : null);
      sendControlUiJson(res, 200, {
        avatarUrl,
        ...controlUiAvatarResolutionMeta(resolved),
      } satisfies ControlUiAvatarMeta);
      return true;
    }

    if ((url.searchParams.has("v") || resolved?.kind === "data") && projection.image) {
      const image = await (
        await loadAvatarThumbnail()
      ).readGatewayAvatarThumbnail(projection.image);
      requestAuth.assertCurrent();
      // Browser HTTP caches must not reuse authenticated bytes after a credential switch.
      res.setHeader("vary", "Authorization, Cookie");
      sendHttpImageResponse({
        req,
        res,
        image,
        filename: "avatar",
        cacheControl:
          url.searchParams.get("v") === projection.image.revision
            ? "private, max-age=31536000, immutable"
            : "private, no-cache",
      });
      return true;
    }

    if (resolved?.kind !== "local" || !projection.file) {
      res.setHeader("Cache-Control", "private, max-age=60");
      res.setHeader("Vary", "Authorization, Cookie");
      respondControlUiNotFound(res);
      return true;
    }

    res.setHeader("Content-Type", resolveAvatarMime(projection.file.path));
    res.setHeader("Cache-Control", "no-cache");
    if (req.method === "HEAD") {
      res.statusCode = 200;
      // Admission records GET's exact byte count without reading the avatar.
      res.setHeader("Content-Length", String(projection.file.stat.size));
      res.end();
      return true;
    }
    res.end(projection.file.body);
    return true;
  } catch {
    if (!res.writableEnded && !res.destroyed) {
      requestAuth.assertCurrent();
      respondControlUiNotFound(res);
    }
    return true;
  }
}

function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  return !(
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("\0")
  );
}

export async function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): Promise<boolean> {
  const startedAt = performance.now();
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;
  // The embedded terminal ships ghostty-web (WASM); the index CSP carries the
  // WASM relaxation whenever the terminal is enabled (the default) and stays
  // strict once operators opt out with gateway.terminal.enabled: false.
  const terminalEnabled = opts?.terminalEnabled ?? isTerminalConfigEnabled(opts?.config);
  const route = classifyControlUiRequest({
    basePath,
    pathname,
    search: url.search,
    method: req.method,
    accept: req.headers?.accept,
  });
  if (route.kind === "not-control-ui") {
    return false;
  }
  if (route.kind === "not-found") {
    applyControlUiSecurityHeaders(res, getRemoteControlUiIngressContext(req));
    respondControlUiNotFound(res);
    return true;
  }
  if (route.kind === "redirect") {
    applyControlUiSecurityHeaders(res, getRemoteControlUiIngressContext(req));
    res.statusCode = 302;
    res.setHeader("Location", route.location);
    res.end();
    return true;
  }

  applyControlUiSecurityHeaders(res, getRemoteControlUiIngressContext(req));

  if (
    isControlUiSharePath(pathname, basePath) &&
    pathname !== `${basePath}/share/card.png` &&
    pathname !== `${basePath}/share/preview-v1.mp4`
  ) {
    serveControlUiShareDocument(req, res, url, basePath, resolveGatewayPublicOrigin(opts?.config));
    return true;
  }

  if (matchesControlUiBootstrapConfigPath(pathname, basePath)) {
    const bootstrap = await prepareControlUiBootstrapConfig(
      req,
      res,
      opts,
      basePath,
      terminalEnabled,
    );
    if (bootstrap) {
      bootstrap.requestAuth.assertCurrent();
      sendControlUiJson(res, 200, bootstrap.config);
    }
    return true;
  }

  const rootState = opts?.root;
  if (!rootState || (rootState.kind !== "bundled" && rootState.kind !== "resolved")) {
    if (!opts?.onUnavailableDocument?.()) {
      respondControlUiAssetsUnavailable(res, rootState);
    }
    return true;
  }

  const root = rootState.path;
  const rootReal =
    rootState.realPath ||
    (await fs.promises.realpath(root).catch((error: unknown) => {
      if (isExpectedSafePathError(error)) {
        return null;
      }
      throw error;
    }));
  if (!rootReal) {
    if (!opts?.onUnavailableDocument?.()) {
      respondControlUiAssetsUnavailable(res);
    }
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const standaloneDocument =
    isControlUiApprovalDocumentPath({ basePath, pathname }) ||
    isControlUiFocusPath(pathname, basePath);
  const rel = (() => {
    if (uiPath === "/share/card.png") {
      return "social-card.png";
    }
    if (uiPath === "/share/preview-v1.mp4") {
      return "social-preview-v1.mp4";
    }
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    if (uiPath.startsWith(CONTROL_UI_NAMESPACE_PREFIX)) {
      const namespacedRel = uiPath.slice(CONTROL_UI_NAMESPACE_PREFIX.length);
      if (isControlUiRootPublicAsset(namespacedRel)) {
        return namespacedRel;
      }
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = standaloneDocument
    ? "index.html"
    : rel && !rel.endsWith("/")
      ? rel
      : `${rel}index.html`;
  let fileRel: string;
  try {
    // Decode the artifact name once, after route ownership and before path validation.
    fileRel = decodeURIComponent(requested);
  } catch {
    respondControlUiNotFound(res);
    return true;
  }
  if (!isSafeRelativePath(fileRel)) {
    respondControlUiNotFound(res);
    return true;
  }
  const filePath = path.resolve(root, fileRel);
  if (!isWithinDir(root, filePath)) {
    respondControlUiNotFound(res);
    return true;
  }

  const isBundledRoot = rootState.kind === "bundled";
  // Bundled sidecars are implementation artifacts selected through
  // Accept-Encoding. Configured roots retain ordinary .br/.gz resources.
  if (isBundledRoot && [".br", ".gz"].includes(path.extname(fileRel).toLowerCase())) {
    respondControlUiNotFound(res);
    return true;
  }
  // Vite fingerprints every file emitted under the bundled assets directory.
  // Configured roots remain revalidated because their naming is not our contract.
  const fingerprintedAsset = isBundledRoot && fileRel.startsWith("assets/");
  const publicAssetBuildId = isBundledRoot ? rootState.publicAssetBuildId : undefined;
  const immutableAsset =
    fingerprintedAsset ||
    Boolean(
      publicAssetBuildId &&
      isImmutableControlUiPublicAsset(fileRel, url.searchParams.get("v"), publicAssetBuildId),
    );
  const readBody =
    req.method !== "HEAD" &&
    req.headers?.["if-none-match"] === undefined &&
    req.headers?.["if-modified-since"] === undefined;
  const encodings = resolveControlUiAssetEncodings({
    req,
    contentPath: fileRel,
    // The mutable worker still revalidates; representation encoding is independent
    // of the immutable cache policy used by fingerprinted assets.
    precompressed: fingerprintedAsset || (isBundledRoot && fileRel === "sw.js"),
  });
  let asset = await readControlUiRootAsset(rootState, fileRel, readBody, encodings);
  if (!asset) {
    // Missing assets stay 404; dotted routes can still use the SPA document.
    if (isControlUiStaticAssetExtension(path.extname(fileRel).toLowerCase())) {
      respondControlUiNotFound(res);
      return true;
    }
    if (!route.spaFallback) {
      return false;
    }
    if (filePath !== path.resolve(root, "index.html")) {
      fileRel = "index.html";
      asset = await readControlUiRootAsset(rootState, fileRel, readBody, encodings);
    }
  }

  while (asset) {
    // Both requested and physical index aliases retain document preparation.
    if (
      path.basename(fileRel) === "index.html" ||
      path.basename(asset.file.path) === "index.html"
    ) {
      if (req.method === "HEAD") {
        using diagnostics = startControlUiDocumentDiagnostics(startedAt);
        using _ = diagnostics?.scope("render");
        const encoding = resolveControlUiHtmlEncoding(req);
        if (encoding === "not-acceptable") {
          respondControlUiNotAcceptable(res);
          return true;
        }
        respondHeadForControlUiFile(res, "index.html", {
          encoding: encoding === "identity" ? undefined : encoding,
        });
        return true;
      }
      if (!asset.file.body) {
        // Document aliases need the source HTML before dynamic preparation/compression.
        asset = await readControlUiRootAsset(rootState, fileRel, true);
        continue;
      }
      using diagnostics = startControlUiDocumentDiagnostics(startedAt);
      const bootstrap = opts?.auth
        ? await prepareControlUiBootstrapConfig(
            req,
            res,
            opts,
            basePath,
            terminalEnabled,
            false,
            diagnostics,
          )
        : undefined;
      using _ = diagnostics?.scope("render");
      await serveControlUiIndexHtml(
        req,
        res,
        asset.file.body.toString("utf8"),
        uiPath,
        basePath,
        terminalEnabled,
        opts?.getRuntimeConfig?.() ?? opts?.config,
        publicAssetBuildId,
        opts?.sessionEntryPath,
        () =>
          bootstrap?.requestAuth.hasCurrentClientAuthority() !== false &&
          opts?.isSessionEntryCurrent?.() !== false,
        opts?.auth?.mode === "trusted-proxy",
        bootstrap?.config,
      );
      return true;
    }
    if (
      respondControlUiStaticAsset(req, res, asset, {
        fileRel,
        encodings,
        immutable: immutableAsset,
      })
    ) {
      return true;
    }
    asset = await readControlUiRootAsset(rootState, fileRel, true, encodings);
  }
  if (!opts?.onUnavailableDocument?.()) {
    respondControlUiNotFound(res);
  }
  return true;
}
