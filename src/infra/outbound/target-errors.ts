export function missingTargetMessage(provider: string, hint?: string): string {
  const suffix = hint ? ` ${hint}` : "";
  return `Delivering to ${provider} requires target${suffix}`;
}

export function missingTargetError(provider: string, hint?: string): Error {
  return new Error(missingTargetMessage(provider, hint));
}
