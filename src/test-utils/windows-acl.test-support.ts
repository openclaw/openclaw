import type { WindowsAccessControlEntry } from "@openclaw/fs-safe/permissions";

export function createWindowsAllowEntry(
  sid: string,
  mask: number,
  inheritable = false,
  inheritOnly = false,
): WindowsAccessControlEntry {
  return {
    sid,
    aceType: "allow",
    mask,
    flags: {
      raw: (inheritable ? 3 : 0) | (inheritOnly ? 8 : 0),
      objectInherit: inheritable,
      containerInherit: inheritable,
      inheritOnly,
      noPropagateInherit: false,
      inherited: false,
      successfulAccess: false,
      failedAccess: false,
    },
  };
}
