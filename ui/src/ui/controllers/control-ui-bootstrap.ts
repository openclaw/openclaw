import { normalizeAssistantIdentity } from "../assistant-identity.ts";
import { resolveUiBrand } from "../brand.ts";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  DEFAULT_CONTROL_UI_PROFILE,
  isControlUiProfile,
  type ControlUiBootstrapConfig,
  type ControlUiProfile,
} from "../control-ui-profile.ts";
import { normalizeBasePath } from "../navigation.ts";

export type ControlUiBootstrapState = {
  basePath: string;
  controlUiProfile?: ControlUiProfile;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
};

export async function loadControlUiBootstrapConfig(state: ControlUiBootstrapState) {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof fetch !== "function") {
    return;
  }

  const basePath = normalizeBasePath(state.basePath ?? "");
  const url = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) {
      return;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    const normalized = normalizeAssistantIdentity({
      agentId: parsed.assistantAgentId ?? null,
      name: parsed.assistantName,
      avatar: parsed.assistantAvatar ?? null,
    });
    const profile = isControlUiProfile(parsed.profile)
      ? parsed.profile
      : DEFAULT_CONTROL_UI_PROFILE;
    state.controlUiProfile = profile;
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAgentId = normalized.agentId ?? null;
    if (typeof document !== "undefined") {
      document.title = `${resolveUiBrand(profile).productName} Gateway`;
    }
  } catch {
    // Ignore bootstrap failures; UI will update identity after connecting.
  }
}
