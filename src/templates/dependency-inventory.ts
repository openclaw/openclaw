import type { TemplateManifest, TemplateDependency } from "./schema.js";

/** The collection owns kind; a local path and a pinned registry release are distinct sources. */
export function templateDependencyInventory(
  manifest: TemplateManifest,
  bundledSources: ReadonlyArray<{ kind: "skill" | "plugin"; path: string; name?: string }> = [],
): TemplateDependency[] {
  return (["skills", "plugins"] as const).flatMap((collection) =>
    manifest[collection].map((entry): TemplateDependency => {
      const kind = collection === "skills" ? "skill" : "plugin";
      if ("path" in entry) {
        const name = bundledSources.find(
          (source) => source.kind === kind && source.path === entry.path,
        )?.name;
        return { kind, source: "bundled", path: entry.path, ...(name ? { name } : {}) };
      }
      return { kind, source: "clawhub", ref: entry.ref, version: entry.version };
    }),
  );
}
