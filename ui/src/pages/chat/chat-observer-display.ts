import { getSafeLocalStorage } from "../../local-storage.ts";

const OBSERVER_DISPLAY_STORAGE_KEY = "openclaw.chat.observerHud.display";

type ChatObserverDisplayPreference = "card" | "pill" | "off";

export function loadChatObserverDisplayPreference(): ChatObserverDisplayPreference {
  try {
    const stored = getSafeLocalStorage()?.getItem(OBSERVER_DISPLAY_STORAGE_KEY);
    return stored === "card" || stored === "off" ? stored : "pill";
  } catch {
    return "pill";
  }
}
