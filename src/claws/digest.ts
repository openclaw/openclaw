import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";

export function digestClawValue(value: unknown): string {
  return `sha256:${sha256StableValue(value).digest}`;
}
