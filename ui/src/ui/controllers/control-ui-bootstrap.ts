// Control UI controller manages control ui bootstrap gateway state.
import type { ControlUiEmbedSandboxMode } from "../../../../src/gateway/control-ui-contract.js";
import { loadLocalAssistantIdentity } from "../../app/assistant-identity.ts";
import { loadApplicationConfig } from "../../app/config.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

export type ControlUiBootstrapState = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  chatMessageMaxWidth?: string | null;
  terminalEnabled?: boolean;
  sessionKey?: string | null;
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

function resolveActiveAgentId(state: ControlUiBootstrapState): string | null {
  const sessionAgentId = parseAgentSessionKey(state.sessionKey)?.agentId;
  if (sessionAgentId) {
    return normalizeAgentId(sessionAgentId);
  }
  const currentAgentId = normalizeOptionalString(state.assistantAgentId);
  return currentAgentId ? normalizeAgentId(currentAgentId) : null;
}

function resolveBootstrapAgentId(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalizeAgentId(normalized) : null;
}

function applyLocalAssistantAvatarOverride(state: ControlUiBootstrapState) {
  const localAvatar = loadLocalAssistantIdentity({ agentId: resolveActiveAgentId(state) }).avatar;
  if (!localAvatar) {
    return;
  }
  state.assistantAvatar = localAvatar;
  state.assistantAvatarSource = localAvatar;
  state.assistantAvatarStatus = "data";
  state.assistantAvatarReason = null;
}

export async function loadControlUiBootstrapConfig(
  state: ControlUiBootstrapState,
  opts?: { applyIdentity?: boolean; skipWithoutAuthCandidate?: boolean },
) {
  const config = await loadApplicationConfig({
    basePath: state.basePath ?? "",
    auth: state,
    skipWithoutAuthCandidate: opts?.skipWithoutAuthCandidate,
  });
  if (!config) {
    return;
  }
  if (opts?.applyIdentity !== false) {
    const activeAgentId = resolveActiveAgentId(state);
    const bootstrapAgentId = resolveBootstrapAgentId(config.assistantIdentity.agentId);
    if (!activeAgentId || !bootstrapAgentId || activeAgentId === bootstrapAgentId) {
      state.assistantName = config.assistantIdentity.name;
      state.assistantAvatar = config.assistantIdentity.avatar;
      state.assistantAvatarSource = config.assistantIdentity.avatarSource;
      state.assistantAvatarStatus = config.assistantIdentity.avatarStatus;
      state.assistantAvatarReason = config.assistantIdentity.avatarReason;
      state.assistantAgentId = config.assistantIdentity.agentId;
    }
    applyLocalAssistantAvatarOverride(state);
  }
  state.serverVersion = config.serverVersion;
  state.localMediaPreviewRoots = config.localMediaPreviewRoots;
  state.embedSandboxMode = config.embedSandboxMode;
  state.allowExternalEmbedUrls = config.allowExternalEmbedUrls;
  state.chatMessageMaxWidth = config.chatMessageMaxWidth;
  state.terminalEnabled = config.terminalEnabled;
}
