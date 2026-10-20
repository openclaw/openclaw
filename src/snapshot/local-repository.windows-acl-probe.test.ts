import fs from "node:fs/promises";
import type { OwnerAndDaclResult, WindowsAccessControlEntry } from "@openclaw/fs-safe/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type WindowsPathSecurity = Extract<OwnerAndDaclResult, { status: "supported" }>;

async function admitRoot(rootPath: string): Promise<string> {
  return await assertTrustedStagingRoot(await fs.lstat(rootPath), rootPath);
}

const CURRENT_USER_FULL_ACCESS: WindowsAccessControlEntry = {
  sid: CURRENT_USER_SID,
  aceType: "allow",
  mask: 0x1f01ff,
  flags: {
    raw: 0,
    objectInherit: false,
    containerInherit: false,
    noPropagateInherit: false,
    inheritOnly: false,
    inherited: false,
    successfulAccess: false,
    failedAccess: false,
  },
};

function untrustedAccess(mask: number, inheritOnly = false): WindowsAccessControlEntry {
  return {
    ...CURRENT_USER_FULL_ACCESS,
    sid: "s-1-1-0",
    mask,
    flags: {
      ...CURRENT_USER_FULL_ACCESS.flags,
      raw: inheritOnly ? 11 : 3,
      objectInherit: true,
      containerInherit: true,
      inheritOnly,
    },
  };
}

function mockWindowsPathSecurity(
  params: {
    ancestorEntries?: WindowsAccessControlEntry[];
    rootEntries?: WindowsAccessControlEntry[];
    rootOwnerSid?: string;
    rootFacts?: Partial<WindowsPathSecurity>;
  } = {},
): void {
  aclMocks.readOwnerAndDaclBatch.mockImplementation(async (paths) =>
    paths.map((_, index) => ({
      status: "supported",
      currentUserSid: CURRENT_USER_SID,
      ownerSid: index === 0 ? (params.rootOwnerSid ?? CURRENT_USER_SID) : CURRENT_USER_SID,
      daclPresent: true,
      isLocal: true,
      complete: true,
      unsupportedAceTypes: [],
      aces:
        index === 0
          ? (params.rootEntries ?? [CURRENT_USER_FULL_ACCESS])
          : (params.ancestorEntries ?? [CURRENT_USER_FULL_ACCESS]),
      ...(index === 0 ? params.rootFacts : {}),
    })),
  );
}

let tempDir: string;
beforeEach(() => {
  tempDir = tempDirs.make("openclaw-snapshot-windows-acl-");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

describe("fail-closed Windows ACL probe", () => {
  it("reports the failed inspection and preserves its diagnostic cause", async () => {
    const error = new Error("Windows permission inspection timed out after 60000ms");
    aclMocks.readOwnerAndDaclBatch.mockRejectedValue(error);
    await expect(admitRoot(tempDir)).rejects.toMatchObject({
      message: expect.stringContaining("Unable to verify private Windows ACL for SQLite staging"),
      cause: error,
    });
  });

  it.each([
    ["root", 0x100000, false, true],
    ["ancestor", 0x000001, false, true],
    ["ancestor", 0x040000, false, false],
    ["ancestor", 0x040000, true, true],
    ["root", 0x040000, true, false],
    ["ancestor", 0x000200, false, false],
  ] as const)(
    "enforces %s access for mask %i with inheritOnly=%s",
    async (role, mask, inheritOnly, allowed) => {
      const entries: WindowsAccessControlEntry[] = [
        CURRENT_USER_FULL_ACCESS,
        untrustedAccess(mask, inheritOnly),
      ];
      mockWindowsPathSecurity(
        role === "root" ? { rootEntries: entries } : { ancestorEntries: entries },
      );
      const result = admitRoot(tempDir);
      if (allowed) {
        await expect(result).resolves.toBe(tempDir);
      } else {
        await expect(result).rejects.toThrow(
          new RegExp(
            `Windows ACL permits untrusted SQLite staging access on ${role === "root" ? "repository root" : "ancestor"}: path=.*principal=S-1-1-0 rights=.*Remove the untrusted grant.*shared or synced root`,
          ),
        );
      }
    },
  );

  it.each([
    [
      "an untrusted read grant",
      { rootEntries: [untrustedAccess(0x120089)] },
      /repository root: path=.*principal=S-1-1-0 rights=.*Remove the untrusted grant.*shared or synced root/u,
    ],
    [
      "an untrusted owner",
      { rootOwnerSid: "S-1-5-21-2000" },
      /repository root is owned by an untrusted principal: path=.*principal=S-1-5-21-2000/u,
    ],
    ["null DACL", { rootFacts: { daclPresent: false } }],
    ["unknown ACE types", { rootFacts: { complete: false, unsupportedAceTypes: [5] } }],
    ["remote filesystem", { rootFacts: { isLocal: false } }],
    ["deny-only DACL", { rootFacts: { aces: [{ ...CURRENT_USER_FULL_ACCESS, aceType: "deny" }] } }],
    ["unsupported inspection", undefined],
  ] satisfies [string, Parameters<typeof mockWindowsPathSecurity>[0], RegExp?][])(
    "rejects %s",
    async (
      _label,
      params,
      expected = /Unable to verify private Windows ACL for SQLite staging/,
    ) => {
      if (params) {
        mockWindowsPathSecurity(params);
      } else {
        aclMocks.readOwnerAndDaclBatch.mockImplementation(async (paths) =>
          paths.map(() => ({ status: "unsupported-platform", platform: "linux" })),
        );
      }
      await expect(admitRoot(tempDir)).rejects.toThrow(expected);
    },
  );
});
