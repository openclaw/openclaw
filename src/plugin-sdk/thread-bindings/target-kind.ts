import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { BindingTargetKind } from "../../infra/outbound/session-binding.types.js";
import { isPluginOwnedBindingMetadata } from "../../plugins/conversation-binding-metadata.js";
import { isAcpSessionKey } from "../../routing/session-key.js";

/** Resolves the stored target kind without mistaking main/global aliases for ordinary sessions. */
export async function resolveThreadBindingTargetKind(params: {
  cfg: OpenClawConfig;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  agentId?: string;
  metadata?: Record<string, unknown>;
  channel: string;
  assertCurrent: () => void;
}): Promise<BindingTargetKind | "acp"> {
  params.assertCurrent();
  if (params.targetKind !== "session") {
    return params.targetKind;
  }
  if (isAcpSessionKey(params.targetSessionKey)) {
    return "acp";
  }
  // Plugin-owned opaque keys have no OpenClaw session-store or agent owner.
  if (isPluginOwnedBindingMetadata(params.metadata)) {
    return "session";
  }
  // Session storage stays lazy, including for explicit subagents and ACP keys.
  const { readAcpSessionEntryAsync } = await import("../../acp/runtime/session-meta-read.js");
  const session = await readAcpSessionEntryAsync({
    cfg: params.cfg,
    sessionKey: params.targetSessionKey,
    agentId: params.agentId,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  if (session?.storeReadFailed) {
    throw new Error(
      `${params.channel} binding target could not be classified; retry when session storage is available.`,
    );
  }
  return session?.acp ? "acp" : "session";
}
