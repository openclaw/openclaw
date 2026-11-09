import type { TemplateManifest, TemplatePackage } from "./schema.js";

/** A collection determines dependency kind; referenced releases always come from ClawHub. */
export function templateDependencyInventory(manifest: TemplateManifest): TemplatePackage[] {
  return [
    ...manifest.skills.map((entry) => ({
      kind: "skill" as const,
      source: "clawhub" as const,
      ...entry,
    })),
    ...manifest.plugins.map((entry) => ({
      kind: "plugin" as const,
      source: "clawhub" as const,
      ...entry,
    })),
  ];
}
