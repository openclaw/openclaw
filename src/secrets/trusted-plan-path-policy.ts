import type { OwnerAndDaclResult } from "@openclaw/fs-safe/permissions";

const TRUSTED_INSTALLER = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const TRUSTED_OWNERS = new Set(["s-1-5-18", "s-1-5-32-544"]);
const WRITE_RIGHTS = 0x500d0156;
const KNOWN_RIGHTS = 0xf01f01ff;
// Read/execute plus adding children; executable parents exclude WD and AD.
const SAFE_DIRECTORY_RIGHTS = 0xa01200af;

export function trustedWindowsPlanPathFailure(
  facts: OwnerAndDaclResult,
  options: { directory: boolean; allowChildCreation: boolean; allowTrustedInstaller: boolean },
): string | undefined {
  if (facts.status !== "supported" || !facts.complete) {
    return "permissions could not be verified";
  }
  const owner = facts.ownerSid.toLowerCase();
  const user = facts.currentUserSid.toLowerCase();
  if (
    !(facts.isLocal && (owner === user || TRUSTED_OWNERS.has(owner))) &&
    !(options.allowTrustedInstaller && owner === TRUSTED_INSTALLER)
  ) {
    return "path is not owned by the current user or root";
  }
  const grants = facts.aces.filter((ace) => {
    const sid = ace.sid.toLowerCase();
    return (
      ace.aceType === "allow" &&
      !ace.flags.inheritOnly &&
      sid !== user &&
      !TRUSTED_OWNERS.has(sid) &&
      sid !== TRUSTED_INSTALLER
    );
  });
  if (!facts.daclPresent) {
    return "path is writable by another user";
  }
  if (!grants.some((ace) => (ace.mask & WRITE_RIGHTS) !== 0)) {
    return undefined;
  }
  const safeRights = options.allowChildCreation
    ? SAFE_DIRECTORY_RIGHTS
    : SAFE_DIRECTORY_RIGHTS & ~0x6;
  // Preserve the inspector's coarse write gate and the rights its summary represented.
  if (
    options.directory &&
    grants.every((ace) => {
      const rights = ace.mask & KNOWN_RIGHTS;
      return rights !== 0 && (rights & ~safeRights) === 0;
    })
  ) {
    return undefined;
  }
  return "path is writable by another user";
}
