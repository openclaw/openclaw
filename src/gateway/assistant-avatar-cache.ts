// Prepared avatar representations retain their source revision through delivery.
import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { resolveMutableAgentEntry } from "../agents/agent-scope-config.js";
import type { PreparedLocalAgentAvatarFile } from "../agents/identity-avatar-file.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";

export type GatewayAvatarImageSource =
  | { file: PreparedLocalAgentAvatarFile; revision: string }
  | { dataUrl: string; revision: string };

const fileSources = new WeakMap<PreparedLocalAgentAvatarFile, GatewayAvatarImageSource>();
const dataSources = new WeakMap<object, Extract<GatewayAvatarImageSource, { dataUrl: string }>>();

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

export function prepareGatewayAvatarDataUrl(
  cfg: OpenClawConfig,
  agentId: string,
  dataUrl: string,
): GatewayAvatarImageSource | undefined {
  const owner = resolveMutableAgentEntry(cfg, agentId) ?? cfg;
  const cached = dataSources.get(owner);
  if (cached?.dataUrl === dataUrl) {
    return cached;
  }
  if (!isRenderableAvatarImageDataUrl(dataUrl)) {
    dataSources.delete(owner);
    return undefined;
  }
  const source: GatewayAvatarImageSource = {
    dataUrl,
    revision: sha256HexPrefixCore(`thumbnail-128-png-v1:${dataUrl}`, 16),
  };
  dataSources.set(owner, source);
  return source;
}
