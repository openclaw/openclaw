import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaUnderstandingConfig } from "../config/types.tools.js";
import {
  clearMediaUnderstandingBinaryCacheForTests as clearExtensionHostMediaUnderstandingBinaryCacheForTests,
  resolveAutoImageModel as resolveExtensionHostAutoImageModel,
  type ActiveMediaModel,
} from "../extension-host/media-runtime-auto.js";
import {
  runCapability as runExtensionHostMediaCapability,
  type RunCapabilityResult,
} from "../extension-host/media-runtime-orchestration.js";
import {
  buildExtensionHostMediaUnderstandingRegistry,
  type ExtensionHostMediaUnderstandingProviderRegistry,
} from "../extension-host/media-runtime-registry.js";
import {
  mergeInboundPathRoots,
  resolveIMessageAttachmentRoots,
} from "../media/inbound-path-policy.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import {
  MediaAttachmentCache,
  type MediaAttachmentCacheOptions,
  normalizeAttachments,
} from "./attachments.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingProvider,
} from "./types.js";

type ProviderRegistry = ExtensionHostMediaUnderstandingProviderRegistry;

export type { ActiveMediaModel, RunCapabilityResult };

export function buildProviderRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
): ProviderRegistry {
  return buildExtensionHostMediaUnderstandingRegistry(overrides);
}

export function normalizeMediaAttachments(ctx: MsgContext): MediaAttachment[] {
  return normalizeAttachments(ctx);
}

export function resolveMediaAttachmentLocalRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] {
  return mergeInboundPathRoots(
    getDefaultMediaLocalRoots(),
    resolveIMessageAttachmentRoots({
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
    }),
  );
}

export function createMediaAttachmentCache(
  attachments: MediaAttachment[],
  options?: MediaAttachmentCacheOptions,
): MediaAttachmentCache {
  return new MediaAttachmentCache(attachments, options);
}

export function clearMediaUnderstandingBinaryCacheForTests(): void {
  clearExtensionHostMediaUnderstandingBinaryCacheForTests();
}

export async function resolveAutoImageModel(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel?: ActiveMediaModel;
}): Promise<ActiveMediaModel | null> {
  return await resolveExtensionHostAutoImageModel({
    ...params,
    providerRegistry: buildProviderRegistry(),
  });
}

export async function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachments: MediaAttachmentCache;
  media: MediaAttachment[];
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
}): Promise<RunCapabilityResult> {
  return await runExtensionHostMediaCapability(params);
}
