import type { TemplatesCatalogDetailResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import { templateDependencyInventory } from "./dependency-inventory.js";
import type { TemplateManifest } from "./types.js";

type CatalogContents = NonNullable<TemplatesCatalogDetailResult["detail"]["contents"]>;

/** Catalog rows disclose the exact dependency identity reviewed by Add. */
export function projectTemplateCatalogDependencies(
  manifest: TemplateManifest,
): Pick<CatalogContents, "skills" | "integrations"> {
  const inventory = templateDependencyInventory(manifest);
  return {
    skills: inventory
      .filter((dependency) => dependency.kind === "skill")
      .map((dependency) => ({
        name: dependency.ref,
        source: dependency.source,
        ref: dependency.ref,
        version: dependency.version,
      })),
    integrations: [
      ...inventory
        .filter((dependency) => dependency.kind === "plugin")
        .map((dependency) => ({
          name: dependency.ref,
          source: dependency.source,
          ref: dependency.ref,
          version: dependency.version,
          kind: "plugin" as const,
        })),
      ...Object.keys(manifest.mcpServers).map((name) => ({ name, kind: "mcpServer" as const })),
    ],
  };
}
