import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  findResumableIntroducedPluginRequirement,
  readClawResumeStateReadOnly,
} from "./package-resume.js";
import type { PersistedClawPackageRef } from "./provenance.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pkg = {
  kind: "plugin" as const,
  source: "clawhub" as const,
  ref: "@owner/audit",
  version: "2.0.1",
};
const preflight = {
  ok: true as const,
  action: "reuse" as const,
  integrity,
  installedIntegrity: integrity,
  installedAt: new Date(1_500).toISOString(),
  detectedFormat: "claude" as const,
  mapped: ["commands", "skills"],
  unavailable: ["agents"],
  adapterIdentity: "openclaw/v1",
};
const ref: PersistedClawPackageRef = {
  schemaVersion: "openclaw.clawPackageRef.v1",
  agentId: "incident-2",
  clawName: "incident-claw",
  ...pkg,
  integrity,
  status: "complete",
  relationship: "referenced",
  origin: "claw-introduced",
  independentOwner: false,
  extension: {
    id: "audit-tools",
    format: "claude",
    detectedFormat: "claude",
    mapped: ["commands", "skills"],
    unavailable: ["agents"],
    adapterIdentity: "openclaw/v1",
  },
  installedAtMs: 1_000,
  updatedAtMs: 2_000,
};

describe("findResumableIntroducedPluginRequirement", () => {
  it("recognizes an exact retained requirement from the incomplete attempt", () => {
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight,
        refs: [ref],
      }),
    ).toEqual(ref);
  });

  it("rejects independently owned and newer plugin installations", () => {
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight,
        refs: [{ ...ref, independentOwner: true }],
      }),
    ).toBeUndefined();
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight: { ...preflight, installedAt: new Date(3_000).toISOString() },
        refs: [ref],
      }),
    ).toBeUndefined();
  });

  it("rejects changed extension capability mappings", () => {
    expect(
      findResumableIntroducedPluginRequirement({
        agentId: "incident-2",
        pkg,
        preflight: { ...preflight, mapped: ["skills"] },
        refs: [ref],
      }),
    ).toBeUndefined();
  });
  it("does not create a state database while checking for a resumable preview", async () => {
    const databasePath = join(tempDirs.make("openclaw-claw-resume-"), "missing.sqlite");

    await expect(
      readClawResumeStateReadOnly("incident-2", { path: databasePath }),
    ).resolves.toBeUndefined();
    await expect(access(databasePath)).rejects.toThrow();
  });
});
