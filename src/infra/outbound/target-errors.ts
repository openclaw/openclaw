export function missingTargetMessage(provider: string, hint?: string): string {
  return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}

export function missingTargetError(provider: string, hint?: string): Error {
  return new Error(missingTargetMessage(provider, hint));
}

export function ambiguousTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}

export function ambiguousTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(ambiguousTargetMessage(provider, raw, hint));
}

export function unknownTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}

export function unknownTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(unknownTargetMessage(provider, raw, hint));
}

function formatTargetHint(hint?: string, withLabel = false): string {
  if (!hint) {
    return "";
  }
  return withLabel ? ` Hint: ${hint}` : ` ${hint}`;
}
