/** Dotted providers cannot collide with Tailscale's email-ish provider aliases. */
export const delegatedProfileProvider = "oce.external";

export type DelegatedUserIdentity = {
  authority: "oce";
  subject: string;
};

export function isDelegatedUserSubject(subject: string): boolean {
  return /^oce:v1:[0-9a-f]{64}$/u.test(subject);
}
