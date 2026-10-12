import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

export type GroupActivationMode = "mention" | "always";

export function normalizeGroupActivation(raw?: string | null): GroupActivationMode | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  return value === "mention" || value === "always" ? value : undefined;
}

export function parseActivationCommand(raw?: string): {
  hasCommand: boolean;
  mode?: GroupActivationMode;
} {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { hasCommand: false };
  }
  const normalized = trimmed.replace(/^\/([^\s:]+)\s*:(.*)$/, (_, cmd: string, rest: string) => {
    const trimmedRest = rest.trimStart();
    return trimmedRest ? `/${cmd} ${trimmedRest}` : `/${cmd}`;
  });
  const match = normalized.match(/^\/activation(?:\s+([a-zA-Z]+))?\s*$/i);
  if (!match) {
    return { hasCommand: false };
  }
  return { hasCommand: true, mode: normalizeGroupActivation(match[1]) };
}
