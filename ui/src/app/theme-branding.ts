import {
  resolveThemeBranding,
  type ThemeBranding,
} from "../../../packages/gateway-protocol/src/theme.ts";
import { registerListener } from "../../../src/shared/listeners.js";

let branding = resolveThemeBranding(undefined);
const listeners = new Set<() => void>();

export function setCurrentThemeBranding(value: ThemeBranding): void {
  branding = value;
  for (const listener of listeners) {
    listener();
  }
}

export function currentThemeBranding(): ThemeBranding {
  return branding;
}

/** Leaf elements outside the app context follow the same published theme. */
export function subscribeThemeBranding(listener: () => void): () => void {
  return registerListener(listeners, listener);
}
