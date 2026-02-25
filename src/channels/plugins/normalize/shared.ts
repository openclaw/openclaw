export function trimMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed || undefined;
}

export function looksLikeHandleOrPhoneTarget(params: {
  raw: string;
  prefixPattern: RegExp;
  phonePattern?: RegExp;
}): boolean {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return false;
  }
  if (params.prefixPattern.test(trimmed)) {
    return true;
  }
  if (trimmed.includes("@")) {
    return true;
  }
  return (params.phonePattern ?? /^\+?\d{3,}$/).test(trimmed);
}
