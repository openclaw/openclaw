import { createHash } from "node:crypto";
/** Stable binding to the complete recipe, including parameters and recovery requirements. */
export function upgradeQualificationRecipeDigest(value: unknown): string {
  function canonical(entry: unknown): string {
    if (Array.isArray(entry)) {
      return `[${entry.map(canonical).join(",")}]`;
    }
    if (entry && typeof entry === "object") {
      return `{${Object.entries(entry)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(entry) ?? "null";
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
