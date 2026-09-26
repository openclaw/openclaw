import fs from "node:fs/promises";
import path from "node:path";
import type { OwnerAndDaclResult, WindowsAccessControlEntry } from "@openclaw/fs-safe/permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const inspections = vi.hoisted(() => ({
  batch: vi.fn<typeof import("@openclaw/fs-safe/permissions").readOwnerAndDaclBatch>(),
  legacy: vi.fn<typeof import("@openclaw/fs-safe/permissions").inspectPathPermissions>(),
}));
vi.mock("@openclaw/fs-safe/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/permissions")>()),
  readOwnerAndDaclBatch: inspections.batch,
  inspectPathPermissions: inspections.legacy,
}));

import {
  resolveTrustedExecutablePath,
  resolveTrustedPlanDirectoryPath,
  resolveTrustedWindowsSystemExecutablePath,
} from "./trusted-plan-path.js";

type WindowsSecurity = Extract<OwnerAndDaclResult, { status: "supported" }>;
const CURRENT_USER = "s-1-5-21-1000";
const EVERYONE = "s-1-1-0";
const TRUSTED_INSTALLER = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const facts = new Map<string, Partial<WindowsSecurity>>();

function allow(mask: number, sid = EVERYONE, inheritOnly = false): WindowsAccessControlEntry {
  return {
    sid,
    mask,
    aceType: "allow",
    flags: {
      raw: inheritOnly ? 11 : 0,
      objectInherit: inheritOnly,
      containerInherit: inheritOnly,
      noPropagateInherit: false,
      inheritOnly,
      inherited: false,
      successfulAccess: false,
      failedAccess: false,
    },
  };
}

function securityFor(file: string): WindowsSecurity {
  return Object.assign(
    {
      status: "supported" as const,
      ownerSid: CURRENT_USER,
      currentUserSid: CURRENT_USER,
      daclPresent: true,
      isLocal: true,
      complete: true,
      unsupportedAceTypes: [],
      aces: [allow(0x1f01ff, CURRENT_USER)],
    },
    facts.get(file),
  );
}

beforeEach(() => {
  facts.clear();
  inspections.batch.mockReset().mockImplementation(async (paths) => paths.map(securityFor));
  // The former owner parsed this native summary as if it contained icacls tokens.
  inspections.legacy.mockReset().mockImplementation(async (file) => {
    const stat = await fs.lstat(file);
    return {
      ok: true,
      isSymlink: stat.isSymbolicLink(),
      isDir: stat.isDirectory(),
      mode: stat.mode,
      bits: stat.mode & 0o777,
      source: "windows-acl",
      ownerSid: CURRENT_USER,
      ownerTrusted: true,
      worldReadable: true,
      worldWritable: true,
      groupReadable: false,
      groupWritable: false,
      aclSummary: "native owner=current-user world=rw group=--",
    };
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = tempDirs.make("trusted-plan-path-");
  const directory = path.join(root, "bin");
  await fs.mkdir(directory);
  const executable = path.join(directory, "tool.exe");
  await fs.writeFile(executable, "synthetic executable", { mode: 0o700 });
  return { root, directory, executable };
}

describe("trusted Windows plan paths", () => {
  it("accepts additive directory rights from native ACL facts without parsing a display summary", async () => {
    const { directory } = await fixture();
    facts.set(directory, { aces: [allow(0x000006)] });
    await expect(resolveTrustedPlanDirectoryPath(directory)).resolves.toBe(directory);
    expect(inspections.batch).toHaveBeenCalledOnce();
  });

  it.each([
    { scope: "parent", mask: 0x000002, accepted: false },
    { scope: "parent", mask: 0x000004, accepted: false },
    { scope: "ancestor", mask: 0x000006, accepted: true },
    { scope: "parent", mask: 0x1200a9, accepted: true },
    { scope: "parent", mask: 0x1f01ff, inheritOnly: true, accepted: true },
    { scope: "file", mask: 0x000002, accepted: false },
  ])("checks $scope rights $mask (accepted=$accepted)", async (row) => {
    const { root, directory, executable } = await fixture();
    const inspected = row.scope === "file" ? executable : row.scope === "parent" ? directory : root;
    facts.set(inspected, { aces: [allow(row.mask, EVERYONE, row.inheritOnly)] });
    const result = resolveTrustedExecutablePath(executable);
    if (row.accepted) {
      await expect(result).resolves.toBe(executable);
    } else {
      await expect(result).rejects.toThrow(`path is writable by another user: ${inspected}`);
    }
  });

  it("limits TrustedInstaller ownership to ancestors and the system-executable resolver", async () => {
    const { root, directory, executable } = await fixture();
    facts.set(root, { ownerSid: TRUSTED_INSTALLER, aces: [allow(0x1f01ff, TRUSTED_INSTALLER)] });
    await expect(resolveTrustedExecutablePath(executable)).resolves.toBe(executable);
    facts.set(executable, {
      ownerSid: TRUSTED_INSTALLER,
      aces: [allow(0x1f01ff, TRUSTED_INSTALLER)],
    });
    await expect(resolveTrustedExecutablePath(executable)).rejects.toThrow(
      `path is not owned by the current user or root: ${executable}`,
    );
    await expect(resolveTrustedWindowsSystemExecutablePath(executable)).resolves.toBe(executable);
    facts.set(directory, { ownerSid: TRUSTED_INSTALLER });
    await expect(resolveTrustedPlanDirectoryPath(directory)).rejects.toThrow(
      `path is not owned by the current user or root: ${directory}`,
    );
  });

  it.each([
    { security: { daclPresent: false, aces: [] }, error: "path is writable by another user" },
    { security: { aces: [] }, error: undefined },
    { security: { complete: false }, error: "permissions could not be verified" },
    { security: { isLocal: false }, error: "path is not owned by the current user or root" },
    { security: { ownerSid: EVERYONE }, error: "path is not owned by the current user or root" },
    { security: { aces: [allow(0x00000200)] }, error: undefined },
    { security: { aces: [allow(0x000004), allow(0)] }, error: "path is writable by another user" },
    {
      security: { aces: [Object.assign(allow(0x1f01ff), { aceType: "deny" as const })] },
      error: undefined,
    },
  ])("preserves descriptor policy for $security", async ({ security, error }) => {
    const { directory } = await fixture();
    facts.set(directory, security);
    const result = resolveTrustedPlanDirectoryPath(directory);
    if (error) {
      await expect(result).rejects.toThrow(`${error}: ${directory}`);
    } else {
      await expect(result).resolves.toBe(directory);
    }
  });

  it("reports a failed batch against the checked chain and retains its cause", async () => {
    const { directory } = await fixture();
    const cause = new Error("permission query failed");
    inspections.batch.mockRejectedValueOnce(cause);
    await expect(resolveTrustedPlanDirectoryPath(directory)).rejects.toMatchObject({
      message: `permissions could not be verified for path chain: ${directory}`,
      cause,
    });
  });

  it.each(["during", "after"] as const)(
    "rejects replacement %s permission verification",
    async (phase) => {
      const { directory } = await fixture();
      let inspected = false;
      const replace = async () => {
        await fs.rename(directory, `${directory}.retained`);
        await fs.mkdir(directory);
      };
      inspections.batch.mockImplementationOnce(async (paths) => {
        const result = paths.map(securityFor);
        if (phase === "during") {
          await replace();
        }
        inspected = true;
        return result;
      });
      if (phase === "after") {
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (inspected && args[0] === path.parse(directory).root) {
            inspected = false;
            await replace();
          }
          return stat;
        });
      }
      await expect(resolveTrustedPlanDirectoryPath(directory)).rejects.toThrow(
        `path changed ${phase} permission verification: ${directory}`,
      );
    },
  );
});
