import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function normalizeSidebarSectionOrder(
  sectionOrder: readonly string[],
  groupNames: readonly string[],
): string[] {
  const groups = new Set(groupNames);
  const normalized = new Set<string>();
  for (const raw of sectionOrder) {
    const sectionId = raw.trim();
    let canonical: string | null = null;
    if (sectionId === "ungrouped" || sectionId === "groups" || sectionId === "work") {
      canonical = sectionId;
    } else if (sectionId.startsWith("category:")) {
      const name = normalizeOptionalString(sectionId.slice("category:".length));
      if (name && groups.has(name)) {
        canonical = `category:${name}`;
      }
    } else if (sectionId.startsWith("catalog:")) {
      const catalogId = normalizeOptionalString(sectionId.slice("catalog:".length));
      if (catalogId) {
        canonical = `catalog:${catalogId}`;
      }
    }
    if (canonical) {
      normalized.add(canonical);
    }
  }
  return [...normalized];
}
