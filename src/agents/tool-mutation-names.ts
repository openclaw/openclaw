import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export type FileMutationToolName = "write" | "edit" | "apply_patch";

export function resolveFileMutationToolName(toolName: string): FileMutationToolName | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  return normalized === "write" || normalized === "edit" || normalized === "apply_patch"
    ? normalized
    : undefined;
}
