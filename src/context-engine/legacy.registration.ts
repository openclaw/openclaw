import { registerContextEngineForOwner } from "./registry.js";

export function registerLegacyContextEngine(): void {
  registerContextEngineForOwner(
    "legacy",
    async () => {
      const { LegacyContextEngine } = await import("./legacy.js");
      return new LegacyContextEngine();
    },
    "core",
    {
      allowSameOwnerRefresh: true,
    },
  );
}
