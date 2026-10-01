// Prepared avatar representations retain their source revision through delivery.
import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import type { PreparedLocalAgentAvatarFile } from "../agents/identity-avatar-file.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import { resolveAvatarMime } from "../shared/avatar-policy.js";

export type GatewayAvatarImageSource =
  | { file: PreparedLocalAgentAvatarFile; revision: string }
  | { dataUrl: string; revision: string };

const fileSources = new WeakMap<PreparedLocalAgentAvatarFile, GatewayAvatarImageSource>();
const inlineFiles = new WeakMap<PreparedLocalAgentAvatarFile, string>();
const dataSources = new Map<string, GatewayAvatarImageSource>();

export function prepareGatewayAvatarFile(
  file: PreparedLocalAgentAvatarFile,
): GatewayAvatarImageSource {
  let source = fileSources.get(file);
  if (!source) {
    source = {
      file,
      revision: sha256HexPrefixCore(
        `thumbnail-128-png-v1:${JSON.stringify([file.path, file.stat])}`,
        16,
      ),
    };
    fileSources.set(file, source);
  }
  return source;
}

export function prepareGatewayAvatarDataUrl(dataUrl: string): GatewayAvatarImageSource | undefined {
  const cached = dataSources.get(dataUrl);
  if (cached) {
    dataSources.delete(dataUrl);
    dataSources.set(dataUrl, cached);
    return cached;
  }
  if (!isRenderableAvatarImageDataUrl(dataUrl)) {
    return undefined;
  }
  const source: GatewayAvatarImageSource = {
    dataUrl,
    revision: sha256HexPrefixCore(`thumbnail-128-png-v1:${dataUrl}`, 16),
  };
  dataSources.set(dataUrl, source);
  pruneMapToMaxSize(dataSources, 4);
  return source;
}

export function gatewayAvatarFileDataUrl(file: PreparedLocalAgentAvatarFile): string | undefined {
  if (!file.body) {
    return undefined;
  }
  let dataUrl = inlineFiles.get(file);
  if (!dataUrl) {
    dataUrl = `data:${resolveAvatarMime(file.path)};base64,${file.body.toString("base64")}`;
    inlineFiles.set(file, dataUrl);
  }
  return dataUrl;
}
