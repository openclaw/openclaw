import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { digestClawHubSkillTree } from "../skills/lifecycle/skill-tree-digest.js";
import type { PackageRemovalDeps } from "./package-remove.js";
import type { PersistedClawPackageRef } from "./provenance.js";

export function packageRef(
  overrides: Partial<PersistedClawPackageRef> = {},
): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "worker",
    clawName: "@acme/worker",
    kind: "plugin",
    source: "clawhub",
    ref: "audit",
    version: "1.0.0",
    integrity: "sha256:audit",
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

export function packageLeaseScope(
  assertOwned: () => void = () => {},
): NonNullable<PackageRemovalDeps["withPackageLease"]> {
  return async (_artifact, operation) =>
    operation({
      signal: new AbortController().signal,
      assertOwned,
      assertOwnedInTransaction: assertOwned,
    });
}

export function packageRefStore(...initial: PersistedClawPackageRef[]) {
  let refs = initial;
  return {
    withPackageLease: packageLeaseScope(),
    readPackageRefs: vi.fn(() => refs),
    readInstallRecords: vi.fn(() => []),
    claimPackageRef: vi.fn(
      (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => {
        const claimed = { ...ref, status };
        refs = refs.map((candidate) =>
          candidate.agentId === ref.agentId &&
          candidate.kind === ref.kind &&
          candidate.source === ref.source &&
          candidate.ref === ref.ref &&
          candidate.version === ref.version
            ? claimed
            : candidate,
        );
        return claimed;
      },
    ),
  };
}

export async function trackedQualifiedSkillFixture(workspaceDir: string) {
  const slug = "triage";
  const skillDir = join(workspaceDir, "skills", slug);
  const content = "---\nname: triage\ndescription: Triage incidents\n---\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const installedAt = 1;
  const registry = "https://clawhub.ai";
  const ownerHandle = "owner";
  await mkdir(join(skillDir, ".clawhub"), { recursive: true });
  await mkdir(join(workspaceDir, ".clawhub"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
  const fileTreeSha256 = await digestClawHubSkillTree(skillDir);
  const trackedMetadata = {
    registry,
    ownerHandle,
    installedAt,
    skillFile: { path: "SKILL.md", sha256 },
    fileTreeSha256,
  };
  await writeFile(
    join(skillDir, ".clawhub", "origin.json"),
    JSON.stringify({
      version: 1,
      slug,
      installedVersion: "1.0.0",
      ...trackedMetadata,
    }),
  );
  const lockPath = join(workspaceDir, ".clawhub", "lock.json");
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      skills: {
        [slug]: {
          version: "1.0.0",
          ...trackedMetadata,
        },
      },
    }),
  );
  return { workspaceDir, slug, skillDir, lockPath };
}
