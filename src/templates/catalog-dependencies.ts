import type { TemplatesCatalogDetailResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import { templateDependencyInventory } from "./dependency-inventory.js";
import type { TemplateBundledSourceSnapshot, TemplateManifest } from "./types.js";

type CatalogContents = NonNullable<TemplatesCatalogDetailResult["detail"]["contents"]>;

/** Catalog rows disclose verified source identity without inventing a registry release for local bytes. */
export function projectTemplateCatalogDependencies(
  manifest: TemplateManifest,
  bundledSources?: TemplateBundledSourceSnapshot[],
): Pick<CatalogContents, "skills" | "integrations"> {
  const inventory = templateDependencyInventory(manifest, bundledSources);
  return {
    skills: inventory
      .filter((dependency) => dependency.kind === "skill")
      .map((dependency) =>
        dependency.source === "bundled"
          ? {
              name: dependency.name ?? dependency.path,
              source: dependency.source,
              path: dependency.path,
            }
          : {
              name: dependency.ref,
              source: dependency.source,
              ref: dependency.ref,
              version: dependency.version,
            },
      ),
    integrations: [
      ...inventory
        .filter((dependency) => dependency.kind === "plugin")
        .map((dependency) =>
          dependency.source === "bundled"
            ? {
                name: dependency.name ?? dependency.path,
                source: dependency.source,
                path: dependency.path,
                kind: "plugin" as const,
              }
            : {
                name: dependency.ref,
                source: dependency.source,
                ref: dependency.ref,
                version: dependency.version,
                kind: "plugin" as const,
              },
        ),
      ...Object.keys(manifest.mcpServers).map((name) => ({ name, kind: "mcpServer" as const })),
    ],
  };
}
