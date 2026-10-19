import { sha256Hex, sha256StableValue } from "@openclaw/normalization-core/node-crypto";

export function digestClawValue(value: unknown): string {
  return `sha256:${sha256StableValue(value).digest}`;
}

export function digestClawBytes(value: Uint8Array): string {
  return `sha256:${sha256Hex(value)}`;
}
