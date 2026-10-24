import fs from "node:fs/promises";
import path from "node:path";
import type { OwnerAndDaclResult, WindowsAccessControlEntry } from "@openclaw/fs-safe/permissions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const inspections = vi.hoisted(() => ({
  batch: vi.fn<typeof import("@openclaw/fs-safe/permissions").readOwnerAndDaclBatch>(),
}));
vi.mock("@openclaw/fs-safe/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/permissions")>()),
  readOwnerAndDaclBatch: inspections.batch,
}));

import {
  resolveTrustedExecutablePath,
  resolveTrustedPlanDirectoryPath,
  resolveTrustedWindowsSystemExecutablePath,
} from "./trusted-plan-path.js";

type WindowsSecurity = Extract<OwnerAndDaclResult, { status: "supported" }>;
type Scope = "directory" | "parent" | "ancestor" | "file" | "system";
const CURRENT_USER = "s-1-5-21-1000";
const EVERYONE = "s-1-1-0";
const TRUSTED_INSTALLER = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const facts = new Map<string, Partial<WindowsSecurity>>();
let root: string, directory: string, executable: string;

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

const securityFor = (file: string): WindowsSecurity => ({
  status: "supported",
  ownerSid: CURRENT_USER,
  currentUserSid: CURRENT_USER,
  daclPresent: true,
  isLocal: true,
  complete: true,
  unsupportedAceTypes: [],
  aces: [allow(0x1f01ff, CURRENT_USER)],
  ...facts.get(file),
});

beforeEach(async () => {
  facts.clear();
  inspections.batch.mockReset().mockImplementation(async (paths) => paths.map(securityFor));
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  root = tempDirs.make("trusted-plan-path-");
  directory = path.join(root, "bin");
  executable = path.join(directory, "tool.exe");
  await fs.mkdir(directory);
  await fs.writeFile(executable, "synthetic executable", { mode: 0o700 });
});
afterEach(() => vi.restoreAllMocks());

const writable = "path is writable by another user";
const unowned = "path is not owned by the current user or root";
it.each<[Scope, Partial<WindowsSecurity>, string?]>([
  ["directory", { aces: [allow(0x000006)] }],
  ["parent", { aces: [allow(0x000002)] }, writable],
  ["parent", { aces: [allow(0x000004)] }, writable],
  ["ancestor", { aces: [allow(0x000006)] }],
  ["parent", { aces: [allow(0x1200a9)] }],
  ["parent", { aces: [allow(0x1f01ff, EVERYONE, true)] }],
  ["file", { aces: [allow(0x000002)] }, writable],
  ["directory", { daclPresent: false, aces: [] }, writable],
  ["directory", { aces: [] }],
  ["directory", { complete: false }, "permissions could not be verified"],
  ["directory", { isLocal: false }, unowned],
  ["directory", { ownerSid: EVERYONE }, unowned],
  ["directory", { aces: [allow(0x00000200)] }],
  ["directory", { aces: [allow(0x000004), allow(0)] }, writable],
  ["directory", { aces: [{ ...allow(0x1f01ff), aceType: "deny" }] }],
  ["ancestor", { ownerSid: TRUSTED_INSTALLER, aces: [allow(0x1f01ff, TRUSTED_INSTALLER)] }],
  ["file", { ownerSid: TRUSTED_INSTALLER, aces: [allow(0x1f01ff, TRUSTED_INSTALLER)] }, unowned],
  ["system", { ownerSid: TRUSTED_INSTALLER, aces: [allow(0x1f01ff, TRUSTED_INSTALLER)] }],
  ["directory", { ownerSid: TRUSTED_INSTALLER }, unowned],
])("checks native %s descriptors: %j", async (scope, security, error) => {
  const inspected =
    scope === "ancestor" ? root : ["file", "system"].includes(scope) ? executable : directory;
  facts.set(inspected, security);
  const result =
    scope === "directory"
      ? resolveTrustedPlanDirectoryPath(directory)
      : scope === "system"
        ? resolveTrustedWindowsSystemExecutablePath(executable)
        : resolveTrustedExecutablePath(executable);
  if (error) {
    await expect(result).rejects.toThrow(`${error}: ${inspected}`);
  } else {
    await expect(result).resolves.toBe(scope === "directory" ? directory : executable);
  }
  expect(inspections.batch).toHaveBeenCalledOnce();
});

it("reports a failed batch against the checked chain and retains its cause", async () => {
  const cause = new Error("permission query failed");
  inspections.batch.mockRejectedValueOnce(cause);
  await expect(resolveTrustedPlanDirectoryPath(directory)).rejects.toMatchObject({
    message: `permissions could not be verified for path chain: ${directory}`,
    cause,
  });
});

it.each(["during", "after"] as const)("rejects replacement %s checks", async (phase) => {
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
});
