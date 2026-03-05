export function isSecretRefShape(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { source: string; id: string } {
  return typeof value.source === "string" && typeof value.id === "string";
}

export function redactSecretRefId(params: {
  value: Record<string, unknown> & { source: string; id: string };
  values: string[];
  redactedSentinel: string;
  isEnvVarPlaceholder: (value: string) => boolean;
}): Record<string, unknown> {
  const { value, values, redactedSentinel, isEnvVarPlaceholder } = params;
  const redacted: Record<string, unknown> = { ...value };
  if (!isEnvVarPlaceholder(value.id)) {
    values.push(value.id);
    redacted.id = redactedSentinel;
  }
  return redacted;
}
