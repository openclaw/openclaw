// Gateway assistant-avatar projection binds the selected value to effective metadata.
import {
  prepareLocalAgentAvatarFile,
  type PreparedLocalAgentAvatarFile,
} from "../agents/identity-avatar-file.js";
import type { AgentAvatarResolution } from "../agents/identity-avatar.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isWindowsAbsolutePath,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";
import {
  gatewayAvatarFileDataUrl,
  prepareGatewayAvatarDataUrl,
  prepareGatewayAvatarFile,
  type GatewayAvatarImageSource,
} from "./assistant-avatar-cache.js";
import { DEFAULT_ASSISTANT_IDENTITY } from "./assistant-identity.js";
import { buildControlUiResourcePath, matchControlUiResourceUrl } from "./control-ui-contract.js";

type GatewayAssistantIdentity = {
  agentId: string;
  avatar: string;
  emoji?: string;
};

type GatewayAssistantAvatarProjection = {
  avatar: string;
  resolution: AgentAvatarResolution | null;
};

type PreparedGatewayAssistantAvatarProjection = {
  resolution: AgentAvatarResolution | null;
  file?: PreparedLocalAgentAvatarFile;
  image?: GatewayAvatarImageSource;
};

export function gatewayAssistantAvatarUrl(
  projection: PreparedGatewayAssistantAvatarProjection,
  basePath: string,
  agentId: string,
): string | undefined {
  return projection.image
    ? `${buildControlUiResourcePath("agentAvatar", basePath, agentId)}?v=${projection.image.revision}`
    : undefined;
}

function resolveSameOriginAvatarUrl(
  basePath: string | undefined,
  source: string,
): string | undefined {
  const unbased = matchControlUiResourceUrl("agentAvatar", source);
  if (unbased) {
    return `${buildControlUiResourcePath("agentAvatar", basePath, unbased.value)}${unbased.search}${unbased.hash}`;
  }
  return matchControlUiResourceUrl("agentAvatar", source, basePath) ? source : undefined;
}

/** Prepare a selected source; the file owner retains descriptor custody in its worker. */
export async function prepareGatewayAssistantAvatar(params: {
  cfg: OpenClawConfig;
  identity: GatewayAssistantIdentity;
  readBody: boolean;
}): Promise<PreparedGatewayAssistantAvatarProjection> {
  const { cfg, identity } = params;
  const source = identity.avatar;
  if (isAvatarHttpUrl(source)) {
    return { resolution: { kind: "remote", url: source, source } };
  }
  if (isAvatarDataUrl(source)) {
    const image = prepareGatewayAvatarDataUrl(source);
    return image
      ? { resolution: { kind: "data", url: source, source }, image }
      : { resolution: { kind: "none", reason: "unsupported_data_url", source } };
  }
  if (hasAvatarUriScheme(source) && !isWindowsAbsolutePath(source)) {
    return { resolution: { kind: "none", reason: "unsupported_uri", source } };
  }
  if (resolveSameOriginAvatarUrl(cfg.gateway?.controlUi?.basePath, source)) {
    return { resolution: null };
  }
  if (!looksLikeAvatarPath(source)) {
    return { resolution: null };
  }

  const prepared = await prepareLocalAgentAvatarFile({
    cfg,
    agentId: identity.agentId,
    source,
    readBody: params.readBody,
  });
  if (!prepared.ok) {
    return { resolution: { kind: "none", reason: prepared.reason, source } };
  }
  return {
    resolution: { kind: "local", filePath: prepared.file.path, source },
    file: prepared.file,
    image: prepareGatewayAvatarFile(prepared.file),
  };
}

/** Resolve one selected identity avatar and its matching public metadata. */
export async function resolveGatewayAssistantAvatar(params: {
  cfg: OpenClawConfig;
  identity: GatewayAssistantIdentity;
  /** Browser clients use authenticated images; native/CLI RPC retains inline avatars. */
  httpBasePath?: string;
}): Promise<GatewayAssistantAvatarProjection> {
  const { cfg, identity } = params;
  const source = identity.avatar;
  const sameOriginAvatarUrl = resolveSameOriginAvatarUrl(
    params.httpBasePath ?? cfg.gateway?.controlUi?.basePath,
    source,
  );
  if (sameOriginAvatarUrl) {
    return { avatar: sameOriginAvatarUrl, resolution: null };
  }
  const prepared = await prepareGatewayAssistantAvatar({
    ...params,
    readBody: params.httpBasePath === undefined,
  });
  if (prepared.resolution?.kind === "none") {
    return {
      avatar: identity.emoji ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
      resolution: prepared.resolution,
    };
  }
  if (params.httpBasePath !== undefined) {
    return {
      avatar: gatewayAssistantAvatarUrl(prepared, params.httpBasePath, identity.agentId) ?? source,
      resolution: prepared.resolution,
    };
  }
  if (!prepared.file) {
    return { avatar: source, resolution: prepared.resolution };
  }

  const dataUrl = gatewayAvatarFileDataUrl(prepared.file);
  if (!dataUrl) {
    return {
      avatar: identity.emoji ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
      resolution: { kind: "none", reason: "unreadable", source },
    };
  }
  return {
    avatar: dataUrl,
    resolution: prepared.resolution,
  };
}
