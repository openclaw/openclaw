import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelApprovalCapability } from "./approvals.js";
import type { ChannelPlugin } from "./types.plugin.js";

/** Runtime capability token used by nodes that can render native approval prompts. */
export const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY = "nativeApprovals";

const NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY_NORMALIZED = "nativeapprovals";

// Keep prompt construction lightweight. Full plugin loading is too expensive on
// prompt-only import paths; plugin-backed checks still cover loaded native
// channels at runtime.
const KNOWN_NATIVE_APPROVAL_PROMPT_CHANNELS = new Set([
  "discord",
  "matrix",
  "qqbot",
  "slack",
  "telegram",
  "signal",
]);

/** Detects native approval UI support from a loaded plugin capability object. */
export function channelPluginHasNativeApprovalPromptUi(
  plugin?: Pick<ChannelPlugin, "approvalCapability"> | null,
): boolean {
  const capability = resolveChannelApprovalCapability(plugin);
  return Boolean(capability?.native || capability?.nativeRuntime);
}

/** Fast prompt-time allowlist for bundled channels with known native approval UI. */
export function isKnownNativeApprovalPromptChannel(channel?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(channel);
  return Boolean(normalized && KNOWN_NATIVE_APPROVAL_PROMPT_CHANNELS.has(normalized));
}

/** Checks node runtime capability lists for native approval prompt support. */
export function hasNativeApprovalPromptRuntimeCapability(
  capabilities?: readonly string[] | null,
): boolean {
  return Boolean(
    capabilities?.some(
      (capability) =>
        normalizeOptionalLowercaseString(capability) ===
        NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY_NORMALIZED,
    ),
  );
}
