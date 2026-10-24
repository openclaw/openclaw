import fs from "node:fs/promises";
import type { OwnerAndDaclResult, WindowsAccessControlEntry } from "@openclaw/fs-safe/permissions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const aclMocks = vi.hoisted(() => ({
  readOwnerAndDaclBatch:
    vi.fn<typeof import("@openclaw/fs-safe/permissions").readOwnerAndDaclBatch>(),
}));
vi.mock("@openclaw/fs-safe/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/permissions")>()),
  readOwnerAndDaclBatch: aclMocks.readOwnerAndDaclBatch,
}));
vi.mock("../process/exec.js", () => ({
  runExec: () => {
    throw new Error("Windows ACL policy must not invoke the POSIX inspection command");
  },
}));
import { assertTrustedStagingRoot } from "./local-repository-directory-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CURRENT_USER_SID = "s-1-5-21-1000";
type Security = Extract<OwnerAndDaclResult, { status: "supported" }>;

function access(
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
const fullAccess = access(CURRENT_USER_SID, 0x1f01ff);
const grant = (mask: number, inheritOnly = false): Partial<Security> => ({
  aces: [fullAccess, access("s-1-1-0", mask, true, inheritOnly)],
});
const inspectionFailure = /Unable to verify private Windows ACL for SQLite staging/;
const accessFailure = (role: string) =>
  new RegExp(
    `Windows ACL permits untrusted SQLite staging access on ${role}: path=.*principal=S-1-1-0 rights=.*Remove the untrusted grant.*shared or synced root`,
  );

function mockSecurity(root: Partial<Security> | null, ancestor: Partial<Security> = {}) {
  aclMocks.readOwnerAndDaclBatch.mockImplementation(async (paths) =>
    paths.map((_, index) =>
      root === null
        ? { status: "unsupported-platform", platform: "linux" }
        : {
            status: "supported",
            currentUserSid: CURRENT_USER_SID,
            ownerSid: CURRENT_USER_SID,
            daclPresent: true,
            isLocal: true,
            complete: true,
            unsupportedAceTypes: [],
            aces: [fullAccess],
            ...(index === 0 ? root : ancestor),
          },
    ),
  );
}

let tempDir: string;
const admitRoot = async () => assertTrustedStagingRoot(await fs.lstat(tempDir), tempDir);
beforeEach(() => {
  tempDir = tempDirs.make("openclaw-snapshot-windows-acl-");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

it("reports failed Windows ACL inspection and preserves its diagnostic cause", async () => {
  const error = new Error("Windows permission inspection timed out after 60000ms");
  aclMocks.readOwnerAndDaclBatch.mockRejectedValue(error);
  await expect(admitRoot()).rejects.toMatchObject({
    message: expect.stringContaining(inspectionFailure.source),
    cause: error,
  });
});

it.each([
  ["root synchronize", null, grant(0x100000)],
  ["ancestor read", null, {}, grant(0x000001)],
  ["verified volume root DELETE-self", null, {}, { ...grant(0x1301bf), isVolumeRoot: true }],
  [
    "ordinary ancestor DELETE-self",
    accessFailure("ancestor"),
    {},
    { ...grant(0x1301bf), isVolumeRoot: false },
  ],
  ["unverified ancestor DELETE-self", accessFailure("ancestor"), {}, grant(0x1301bf)],
  [
    "private volume root DELETE-self",
    accessFailure("repository root"),
    { ...grant(0x010000), isVolumeRoot: true },
  ],
  ...[0x000040, 0x040000, 0x080000, 0x02000000, 0x10000000, 0x000200].map(
    (right): [string, RegExp, Partial<Security>, Partial<Security>] => [
      `verified volume root unsafe right ${right.toString(16)}`,
      accessFailure("ancestor"),
      {},
      { ...grant(0x1301bf | right), isVolumeRoot: true },
    ],
  ),
  [
    "remote volume root",
    inspectionFailure,
    {},
    { ...grant(0x1301bf), isVolumeRoot: true, isLocal: false },
  ],
  ["ancestor write DACL", accessFailure("ancestor"), {}, grant(0x040000)],
  ["ancestor inherit-only write DACL", null, {}, grant(0x040000, true)],
  ["root inherit-only write DACL", accessFailure("repository root"), grant(0x040000, true)],
  ["ancestor unknown rights", accessFailure("ancestor"), {}, grant(0x000200)],
  [
    "untrusted root read",
    accessFailure("repository root"),
    { aces: [access("s-1-1-0", 0x120089, true)] },
  ],
  [
    "untrusted owner",
    /repository root is owned by an untrusted principal: path=.*principal=S-1-5-21-2000/u,
    { ownerSid: "S-1-5-21-2000" },
  ],
  ["null DACL", inspectionFailure, { daclPresent: false }],
  ["unknown ACE types", inspectionFailure, { complete: false, unsupportedAceTypes: [5] }],
  ["remote filesystem", inspectionFailure, { isLocal: false }],
  ["deny-only DACL", inspectionFailure, { aces: [{ ...fullAccess, aceType: "deny" }] }],
  ["unsupported inspection", inspectionFailure, null],
] satisfies [string, RegExp | null, Partial<Security> | null, Partial<Security>?][])(
  "enforces Windows ACL admission: %s",
  async (_label, error, root, ancestor: Partial<Security> = {}) => {
    mockSecurity(root, ancestor);
    const result = admitRoot();
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      await expect(result).resolves.toBe(tempDir);
    }
  },
);
