import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

export function isProfileDisplayRow(value: unknown): value is ProfileDisplayRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.updated_at === "number" &&
    (value.has_avatar === 0 || value.has_avatar === 1) &&
    ["display_name", "avatar_mime", "avatar_sha256", "merged_into"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) &&
    (value.role === undefined || value.role === null || typeof value.role === "string")
  );
}
