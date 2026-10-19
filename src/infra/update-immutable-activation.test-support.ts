import fs from "node:fs";
import path from "node:path";
import {
  createImmutableInstallRecord,
  recordImmutablePreparedGeneration,
} from "./package-update-activation-immutable.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { immutableLayout, identity } from "./update-immutable-layout.test-support.js";
export { identity } from "./update-immutable-layout.test-support.js";
import type {
  ImmutableActivationOperation,
  ImmutableInstallDescriptor,
  ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";
import type { ImmutableProtectionSnapshot } from "./update-immutable-protection-schema.js";
import type { ImmutableServiceObservation } from "./update-immutable-service.js";
import type { ImmutableGatewayObservation } from "./update-immutable-verification.js";

export const previousSha = "a".repeat(40);
export const candidateSha = "b".repeat(40);

export function syntheticActivationCustody(
  descriptor: ImmutableInstallDescriptor,
  [generationIdentity, helperIdentity]: readonly [string, string],
): Pick<ImmutableActivationOperation, "authority" | "recovery"> {
  const root = descriptor.root;
  const journal = resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
  const control = path.dirname(journal);
  return {
    authority: {
      databasePath: journal,
      databaseIdentity: identity(journal),
      parentIdentity: identity(control),
      installKey: root,
      owner: "synthetic-executor",
    },
    recovery: {
      root,
      path: path.join(control, `recovery-${descriptor.current.sha}`),
      sha: descriptor.current.sha,
      identity: generationIdentity,
      buildDigest: descriptor.current.buildDigest,
      helperPath: path.join(control, "recovery.mjs"),
      helperIdentity,
      helperDigest: "6".repeat(64),
    },
  };
}

export function syntheticImmutableServiceObservation(
  descriptor: ImmutableInstallDescriptor,
  serving: { pid: number; generationPath: string } | null,
): ImmutableServiceObservation {
  return {
    phase: serving ? "running" : "stopped",
    definitionDigest: "d".repeat(64),
    pid: serving?.pid ?? null,
    processStartTicks: serving ? String(serving.pid * 100) : null,
    generationPath: serving?.generationPath ?? null,
    runtimePath: descriptor.runtime.path,
    controlGroup: "/system.slice/immutable-fixture.service",
    state: {
      installed: true,
      loadState: { status: "loaded" },
      running: serving !== null,
      command: null,
      env: {
        OPENCLAW_STATE_DIR: descriptor.service.stateDir,
        OPENCLAW_CONFIG_PATH: descriptor.service.configPath,
      },
      runtime: serving ? { status: "running", pid: serving.pid } : { status: "stopped" },
    },
    identity: {
      scope: "system",
      unitName: descriptor.service.unit,
      unitPath: "/synthetic/service",
      bus: { address: "synthetic" },
      busId: "bus",
      managerOwner: "manager",
      managerUid: 0,
      serviceUser: descriptor.service.account,
    },
  };
}

export function syntheticImmutableGatewayObservation(
  descriptor: ImmutableInstallDescriptor,
  generation: Pick<ImmutablePreparedGeneration, "sha">,
  serving: { pid: number; generationPath: string } | null,
  outcome: ImmutableGatewayObservation["outcome"],
): ImmutableGatewayObservation {
  return {
    outcome,
    service: syntheticImmutableServiceObservation(descriptor, serving),
    ...(outcome === "verified" && serving
      ? {
          verification: {
            pid: serving.pid,
            bootId: `boot-${serving.pid}`,
            version: "2026.10.3",
            buildId: generation.sha,
            generationSha: generation.sha,
          },
        }
      : {}),
  };
}

/** Physical pointer and SQLite fixture; only privileged ownership is projected. */
export function createImmutableActivationLayout(parent: string) {
  const descriptor: ImmutableInstallDescriptor = {
    ...immutableLayout(parent, {
      sha: previousSha,
      buildDigest: "1".repeat(64),
      unit: "immutable-fixture.service",
      account: "synthetic",
      ownParent: true,
    }),
    version: 2,
    activationEnabled: true,
  };
  const root = descriptor.root;
  const candidatePath = path.join(root, "releases", candidateSha);
  const schemaVersions = { state: 1, agent: 1 };
  fs.mkdirSync(candidatePath, { mode: 0o755 });
  for (const generation of [descriptor.current.path, candidatePath]) {
    fs.writeFileSync(
      path.join(generation, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.10.3",
        openclaw: { schemaVersions },
      }),
    );
  }
  const candidate: ImmutablePreparedGeneration = {
    sha: candidateSha,
    path: candidatePath,
    identity: identity(candidatePath),
    buildDigest: "2".repeat(64),
    preparedAtMs: 1,
    schemaVersions,
  };
  recordImmutablePreparedGeneration(
    createImmutableInstallRecord(descriptor, () => {}),
    candidate,
    () => {},
  );
  return { root, descriptor, candidate, protection: syntheticImmutableProtection(descriptor) };
}

export function syntheticImmutableProtection(
  descriptor: ImmutableInstallDescriptor,
  options = { key: "synthetic-state", hash: "3".repeat(64), policyFingerprint: "4".repeat(64) },
): ImmutableProtectionSnapshot {
  const protectedFile = { dev: "1", ino: "2", mode: 0o600, nlink: 1 as const, uid: 0, gid: 0 };
  const statePath = path.join(descriptor.service.stateDir, "openclaw.db");
  return {
    capturedAtMs: 1,
    auditBoundary: null,
    state: {
      path: statePath,
      identity: protectedFile,
      pathProof: { targetPath: statePath, entries: [] },
      key: options.key,
    },
    config: [
      {
        path: descriptor.service.configPath,
        identity: protectedFile,
        pathProof: { targetPath: descriptor.service.configPath, entries: [] },
        hash: options.hash,
        fingerprint: {},
        policyFingerprint: options.policyFingerprint,
      },
    ],
  };
}
