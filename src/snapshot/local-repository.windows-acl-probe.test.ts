import fs from "node:fs/promises";
import type { OwnerAndDaclResult, WindowsAccessControlEntry } from "@openclaw/fs-safe/permissions";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("fail-closed Windows ACL probe", () => {
  it("reports the failed inspection and preserves its diagnostic cause", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-probe-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const error = new Error("Windows permission inspection timed out after 60000ms");
    aclMocks.readOwnerAndDaclBatch.mockRejectedValue(error);
    await expect(admitRoot(tempDir)).rejects.toMatchObject({
      message: expect.stringContaining("Unable to verify private Windows ACL for SQLite staging"),
      cause: error,
    });
  });

  it("names the untrusted root principal and rights without weakening rejection", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-detail-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsPathSecurity({
      rootEntries: [
        {
          ...CURRENT_USER_FULL_ACCESS,
          sid: "s-1-1-0",
          mask: 0x120089,
          flags: {
            ...CURRENT_USER_FULL_ACCESS.flags,
            raw: 3,
            containerInherit: true,
            objectInherit: true,
          },
        },
      ],
    });

    await expect(admitRoot(tempDir)).rejects.toThrow(
      /repository root: path=.* principal=S-1-1-0 rights=.*Remove the untrusted grant/u,
    );
  });

  it.each([
    CURRENT_USER_SID,
    "s-1-5-18",
    "s-1-5-32-544",
    "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
  ])("accepts a private local Windows repository owned by %s", async (rootOwnerSid) => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-private-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsPathSecurity({
      rootOwnerSid,
      rootEntries: [CURRENT_USER_SID, "s-1-5-18", "s-1-5-32-544", "s-1-3-0"].map((sid) =>
        Object.assign({}, CURRENT_USER_FULL_ACCESS, { sid }),
      ),
    });

    await expect(admitRoot(tempDir)).resolves.toBe(tempDir);
  });

  it.each([
    { role: "root", rightsMask: 0x100000, inheritOnly: false, allowed: true },
    { role: "ancestor", rightsMask: 0x000001, inheritOnly: false, allowed: true },
    { role: "ancestor", rightsMask: 0x040000, inheritOnly: false, allowed: false },
    { role: "ancestor", rightsMask: 0x040000, inheritOnly: true, allowed: true },
    { role: "root", rightsMask: 0x040000, inheritOnly: true, allowed: false },
    { role: "root", rightsMask: 0x80000000, inheritOnly: false, allowed: false },
    { role: "ancestor", rightsMask: 0x000200, inheritOnly: false, allowed: false },
  ])("enforces $role access for mask $rightsMask with inheritOnly=$inheritOnly", async (row) => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-rights-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const entries: WindowsAccessControlEntry[] = [
      CURRENT_USER_FULL_ACCESS,
      {
        ...CURRENT_USER_FULL_ACCESS,
        sid: "s-1-1-0",
        mask: row.rightsMask,
        flags: {
          ...CURRENT_USER_FULL_ACCESS.flags,
          raw: row.inheritOnly ? 11 : 3,
          objectInherit: true,
          containerInherit: true,
          inheritOnly: row.inheritOnly,
        },
      },
    ];
    mockWindowsPathSecurity(
      row.role === "root" ? { rootEntries: entries } : { ancestorEntries: entries },
    );
    const result = admitRoot(tempDir);
    if (row.allowed) {
      await expect(result).resolves.toBe(tempDir);
    } else {
      await expect(result).rejects.toThrow("Windows ACL permits untrusted SQLite staging access");
    }
  });

  it.each([
    {
      label: "a OneDrive-style synced root",
      params: {
        rootEntries: [
          {
            ...CURRENT_USER_FULL_ACCESS,
            sid: "s-1-1-0",
          },
        ],
      },
      expected: /repository root: path=.*principal=S-1-1-0 rights=.*shared or synced root/u,
    },
    {
      label: "a root owned by another principal",
      params: { rootOwnerSid: "S-1-5-21-2000" },
      expected:
        /repository root is owned by an untrusted principal: path=.*principal=S-1-5-21-2000/u,
    },
    {
      label: "an inherited shared ancestor grant",
      params: {
        ancestorEntries: [
          {
            ...CURRENT_USER_FULL_ACCESS,
            sid: "s-1-1-0",
            mask: 0x000040,
          },
        ],
      },
      expected: /ancestor: path=.*principal=S-1-1-0 rights=.*shared or synced root/u,
    },
  ])("rejects $label", async ({ params, expected }) => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-matrix-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsPathSecurity(params);

    await expect(admitRoot(tempDir)).rejects.toThrow(expected);
  });

  it.each([
    { label: "null DACL", facts: { daclPresent: false } },
    { label: "unknown ACE types", facts: { complete: false, unsupportedAceTypes: [5] } },
    { label: "remote filesystem", facts: { isLocal: false } },
    { label: "empty DACL", facts: { aces: [] } },
    {
      label: "deny-only DACL",
      facts: { aces: [{ ...CURRENT_USER_FULL_ACCESS, aceType: "deny" as const }] },
    },
  ])("rejects a root with $label", async ({ facts }) => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-incomplete-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockWindowsPathSecurity({ rootFacts: facts });
    await expect(admitRoot(tempDir)).rejects.toThrow(
      "Unable to verify private Windows ACL for SQLite staging",
    );
  });

  it("rejects unsupported descriptor inspection", async () => {
    const tempDir = tempDirs.make("openclaw-snapshot-windows-acl-unsupported-");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    aclMocks.readOwnerAndDaclBatch.mockImplementation(async (paths) =>
      paths.map(() => ({ status: "unsupported-platform", platform: "linux" })),
    );
    await expect(admitRoot(tempDir)).rejects.toThrow(
      "Unable to verify private Windows ACL for SQLite staging",
    );
  });
});
