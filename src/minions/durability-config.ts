import { loadConfig } from "../config/config.js";

export type DurabilityMode = "minions" | "legacy";

export function resolveDurabilityMode(): DurabilityMode {
  try {
    const cfg = loadConfig();
    const raw = (cfg as Record<string, unknown>).minions;
    if (raw && typeof raw === "object" && "durability" in raw) {
      const mode = (raw as Record<string, unknown>).durability;
      if (mode === "legacy") {
        return "legacy";
      }
    }
  } catch {
    // Config unavailable (tests, early startup). Default to minions.
  }
  return "minions";
}
