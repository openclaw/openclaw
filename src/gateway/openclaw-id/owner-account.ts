// The claw's OpenClaw ID owner account (Discovery's owner_account_id, an OpenClaw ID `sub`).
// Owner-device approval requires the new browser to be signed in to that account, so every
// owner device is that account's person. When the account is linked to a profile (Settings →
// Profile → Identity), owner devices are attributed to that profile instead of the shared
// owner. Attribution only: owner authority still comes from the device certificate.
// The OpenClaw ID service publishes the resolver while it runs.

let resolver: (() => string | undefined) | undefined;

/** Publishes or clears the owner-account resolver (the OpenClaw ID service does this). */
export function setOpenClawIdOwnerAccountResolver(next: (() => string | undefined) | undefined) {
  resolver = next;
}

/** The claw's OpenClaw ID owner account, while OpenClaw ID runs and the claw is linked. */
export function resolveOpenClawIdOwnerAccount(): string | undefined {
  return resolver?.();
}

/** The profile owner devices are attributed to, or null for the shared owner. */
export async function resolveOpenClawIdOwnerProfile(): Promise<{
  profileId: string;
  updatedAt: number;
} | null> {
  const accountId = resolveOpenClawIdOwnerAccount();
  if (!accountId) {
    return null;
  }
  const { readOpenClawIdLinkedProfile } = await import("../../state/user-profile-openclaw-id.js");
  return await readOpenClawIdLinkedProfile(accountId);
}
