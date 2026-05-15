import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type ThreadBindingPlacement = "current" | "child";
type ThreadBindingAutomaticSpawnKind = "subagent" | "acp";

type ThreadBindingInboundConversationParams = {
  from?: string;
  to?: string;
  conversationId?: string;
  threadId?: string | number;
  isGroup: boolean;
};

type ThreadBindingConversationRef = {
  conversationId?: string;
  parentConversationId?: string;
};

type ThreadBindingApi = {
  defaultTopLevelPlacement?: unknown;
  supportsAutomaticThreadBindingSpawn?: unknown;
  resolveInboundConversation?: (
    params: ThreadBindingInboundConversationParams,
  ) => ThreadBindingConversationRef | null;
};

const THREAD_BINDING_API_ARTIFACT_BASENAME = "thread-binding-api.js";
const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";

function loadBundledChannelThreadBindingApi(channelId: string): ThreadBindingApi | undefined {
  const cacheKey = channelId.trim();
  try {
    return loadBundledPluginPublicArtifactModuleSync<ThreadBindingApi>({
      dirName: cacheKey,
      artifactBasename: THREAD_BINDING_API_ARTIFACT_BASENAME,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) {
      return undefined;
    }
    throw error;
  }
}

function normalizeThreadBindingPlacement(value: unknown): ThreadBindingPlacement | undefined {
  const normalized = normalizeOptionalString(typeof value === "string" ? value : undefined);
  return normalized === "current" || normalized === "child" ? normalized : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeThreadBindingAutomaticSpawnSupport(
  value: unknown,
  kind?: ThreadBindingAutomaticSpawnKind,
): boolean | undefined {
  const booleanValue = normalizeBoolean(value);
  if (booleanValue !== undefined) {
    return booleanValue;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const support = value as Record<ThreadBindingAutomaticSpawnKind, unknown>;
  if (kind) {
    return normalizeBoolean(support[kind]) ?? false;
  }
  const subagent = normalizeBoolean(support.subagent);
  const acp = normalizeBoolean(support.acp);
  if (subagent === undefined && acp === undefined) {
    return undefined;
  }
  return subagent === true || acp === true;
}

export function resolveBundledChannelThreadBindingDefaultPlacement(
  channelId: string,
): ThreadBindingPlacement | undefined {
  return normalizeThreadBindingPlacement(
    loadBundledChannelThreadBindingApi(channelId)?.defaultTopLevelPlacement,
  );
}

export function resolveBundledChannelThreadBindingAutomaticSpawnSupport(
  channelId: string,
  kind?: ThreadBindingAutomaticSpawnKind,
): boolean | undefined {
  return normalizeThreadBindingAutomaticSpawnSupport(
    loadBundledChannelThreadBindingApi(channelId)?.supportsAutomaticThreadBindingSpawn,
    kind,
  );
}

export function resolveBundledChannelThreadBindingInboundConversation(
  params: ThreadBindingInboundConversationParams & { channelId: string },
): ThreadBindingConversationRef | null | undefined {
  const api = loadBundledChannelThreadBindingApi(params.channelId);
  if (typeof api?.resolveInboundConversation !== "function") {
    return undefined;
  }
  return api.resolveInboundConversation({
    from: params.from,
    to: params.to,
    conversationId: params.conversationId,
    threadId: params.threadId,
    isGroup: params.isGroup,
  });
}
