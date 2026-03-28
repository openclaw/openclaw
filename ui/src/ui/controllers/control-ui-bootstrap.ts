import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
} from "../../../../src/gateway/control-ui-contract.js";
import { normalizeAssistantIdentity } from "../assistant-identity.ts";
import { normalizeBasePath } from "../navigation.ts";

export type ControlUiBootstrapState = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  seamColor: string | null;
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
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAgentId = normalized.agentId ?? null;
    state.serverVersion = parsed.serverVersion ?? null;
    if (parsed.seamColor) {
      state.seamColor = parsed.seamColor;
      applySeamColor(parsed.seamColor);
    }
  } catch {
    // Ignore bootstrap failures; UI will update identity after connecting.
  }
}

function applySeamColor(hexColor: string) {
  if (typeof document === "undefined") {
    return;
  }
  // Ensure the color has a # prefix for parsing
  const normColor = hexColor.startsWith("#") ? hexColor : `#${hexColor}`;
  
  // Parse hex to RGB
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normColor);
  if (!result) {
    return;
  }
  
  const r = parseInt(result[1], 16);
  const g = parseInt(result[2], 16);
  const b = parseInt(result[3], 16);
  
  // Apply accent color and its variations to the root element
  const root = document.documentElement;
  root.style.setProperty("--accent", normColor);
  root.style.setProperty("--primary", normColor);
  root.style.setProperty("--ring", normColor);
  
  // Generate hover color (lighter by 15%)
  const hoverR = Math.min(255, Math.round(r * 1.15));
  const hoverG = Math.min(255, Math.round(g * 1.15));
  const hoverB = Math.min(255, Math.round(b * 1.15));
  const hoverColor = `#${hoverR.toString(16).padStart(2, "0")}${hoverG.toString(16).padStart(2, "0")}${hoverB.toString(16).padStart(2, "0")}`;
  root.style.setProperty("--accent-hover", hoverColor);
  
  // Generate subtle color (10% opacity)
  root.style.setProperty("--accent-subtle", `rgba(${r}, ${g}, ${b}, 0.1)`);
  
  // Generate glow color (20% opacity)
  root.style.setProperty("--accent-glow", `rgba(${r}, ${g}, ${b}, 0.2)`);
  
  // Muted is same as base color
  root.style.setProperty("--accent-muted", normColor);
}
}
