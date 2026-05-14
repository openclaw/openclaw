import { registerContextEngineForOwner } from "./registry.js";
import { ContextMeshContextEngine } from "./contextmesh.js";

export function registerContextMeshContextEngine(): void {
  registerContextEngineForOwner("contextmesh", async () => new ContextMeshContextEngine(), "core", {
    allowSameOwnerRefresh: true,
  });
}
