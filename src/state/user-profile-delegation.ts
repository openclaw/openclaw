export const delegatedProfileAuthority = "oce";
const delegatedUserSubjectPrefix = `${delegatedProfileAuthority}:v1:`;

/** Dotted providers cannot collide with Tailscale's email-ish provider aliases. */
export const delegatedProfileProvider = `${delegatedProfileAuthority}.external`;

export type DelegatedUserIdentity = {
  authority: typeof delegatedProfileAuthority;
  subject: string;
};

export function isDelegatedUserSubject(subject: string): boolean {
  return (
    subject.startsWith(delegatedUserSubjectPrefix) &&
    /^[0-9a-f]{64}$/u.test(subject.slice(delegatedUserSubjectPrefix.length))
  );
}
