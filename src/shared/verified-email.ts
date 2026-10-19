/** Provider metadata must contain one bounded mailbox, never a login alias or header list. */
export function normalizeVerifiedEmail(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const email = value.trim();
  return email.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(email)
    ? email.toLowerCase()
    : undefined;
}
