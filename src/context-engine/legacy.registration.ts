import { registerContextEngineForOwner } from "./registry.js";
import type { ContextEngine } from "./types.js";

type LegacyContextEngineModule = {
  LegacyContextEngine: new () => ContextEngine;
};

async function loadLegacyContextEngineModule(): Promise<LegacyContextEngineModule> {
  try {
    return (await import("./legacy.js")) as LegacyContextEngineModule;
  } catch {
    try {
      return (await import("./legacy.ts")) as LegacyContextEngineModule;
    } catch {
      throw new Error("Failed to load legacy context engine runtime.");
    }
  }
}

export function registerLegacyContextEngine(): void {
  registerContextEngineForOwner(
    "legacy",
    async () => {
      const { LegacyContextEngine } = await loadLegacyContextEngineModule();
      return new LegacyContextEngine();
    },
    "core",
    {
      allowSameOwnerRefresh: true,
    },
  );
}
