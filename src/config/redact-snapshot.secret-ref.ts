/** Narrows plain objects that carry the minimum SecretRef fields used by redaction. */
export function isSecretRefShape(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { source: string; id: string } {
  return typeof value.source === "string" && typeof value.id === "string";
}
