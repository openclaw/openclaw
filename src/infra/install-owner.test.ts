import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processExec from "../process/exec.js";
import { readInstallOwner } from "./install-owner.js";
import {
  checkUpdateStatus,
  resolveUpdateInstallIdentity,
  resolveUpdateInstallKind,
} from "./update-check.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn }) }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  warn.mockClear();
});
const owner = {
  schemaVersion: 1,
  owner: "macos-app",
  displayName: "OpenClaw.app",
  updateHint: "Update OpenClaw.app to update this Gateway.",
};

it("discovers host ownership before any Git, package manager, or registry probe", async () => {
  const root = tempDirs.make("openclaw-install-owner-");
  await fs.writeFile(path.join(root, "openclaw-install-owner.json"), JSON.stringify(owner));
  const command = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockRejectedValue(new Error("unexpected subprocess"));
  const fetch = vi.fn().mockRejectedValue(new Error("unexpected registry request"));
  vi.stubGlobal("fetch", fetch);
  try {
    expect(await resolveUpdateInstallKind(root)).toBe("host");
    expect(await resolveUpdateInstallIdentity({ root })).toMatchObject({
      installKind: "host",
      installOwner: owner,
    });
    expect(await checkUpdateStatus({ root, fetchGit: true, includeRegistry: true })).toEqual({
      root,
      installKind: "host",
      installOwner: owner,
      packageManager: "unknown",
    });
    expect(command).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  ["malformed JSON", "{"],
  ["unknown schema", JSON.stringify({ ...owner, schemaVersion: 2 })],
  ["unknown owner", JSON.stringify({ ...owner, owner: "other" })],
  ["blank hint", JSON.stringify({ ...owner, updateHint: " " })],
  ["null", "null"],
])("ignores %s with a warning", async (_label, content) => {
  const root = tempDirs.make("openclaw-install-owner-invalid-");
  await fs.writeFile(path.join(root, "openclaw-install-owner.json"), content);
  expect(await readInstallOwner(root)).toBeNull();
  expect(warn).toHaveBeenCalledOnce();
});

it("ignores an absent marker without warning", async () => {
  const root = tempDirs.make("openclaw-install-owner-absent-");
  expect(await readInstallOwner(root)).toBeNull();
  expect(await readInstallOwner(null)).toBeNull();
  expect(warn).not.toHaveBeenCalled();
});
