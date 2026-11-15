/**
 * The name a nameless OpenClaw ID member takes from its reported email: the local part, as an
 * email sign-in is named. The Control UI compares against it to tell this from a chosen name.
 */
export function openClawIdEmailDisplayName(email: string | null | undefined): string | null {
  return email?.trim().split("@", 1)[0]?.trim() || null;
}
