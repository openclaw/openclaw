import { normalizeOptionalString } from "../../shared/string-coerce.js";

export function extractSimpleExplicitGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of trimmed.split(":")) {
    if (part) {
      parts.push(part);
    }
  }
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    let joined = parts[2] ?? "";
    for (let i = 3; i < parts.length; i++) {
      joined += `:${parts[i]}`;
    }
    return joined.replace(/:topic:.*$/, "") || undefined;
  }
  if (parts.length >= 2 && (parts[0] === "group" || parts[0] === "channel")) {
    let joined = parts[1] ?? "";
    for (let i = 2; i < parts.length; i++) {
      joined += `:${parts[i]}`;
    }
    return joined.replace(/:topic:.*$/, "") || undefined;
  }
  return undefined;
}
