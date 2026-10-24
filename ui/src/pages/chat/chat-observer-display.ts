import { getSafeLocalStorage } from "../../local-storage.ts";

const OBSERVER_DISPLAY_STORAGE_KEY = "openclaw.chat.observerHud.display";

export function loadChatObserverDisplayPreference(): "card" | "pill" | "off" {
  try {
    const stored = getSafeLocalStorage()?.getItem(OBSERVER_DISPLAY_STORAGE_KEY);
    return stored === "card" || stored === "off" ? stored : "pill";
  } catch {
    return "pill";
  }
}
