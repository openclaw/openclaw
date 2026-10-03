import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import {
  createImmutableInstallRecord,
  recordImmutablePreparedGeneration,
} from "./package-update-activation-immutable.js";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type {
  ImmutableInstallDescriptor,
  ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";
import type { ImmutableProtectionSnapshot } from "./update-immutable-protection-schema.js";
import type { ImmutableServiceObservation } from "./update-immutable-service.js";
import type { ImmutableGatewayObservation } from "./update-immutable-verification.js";

export const previousSha = "a".repeat(40);
export const candidateSha = "b".repeat(40);
export const identity = (file: string) => {
  const stat = fs.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};

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
  generation: Pick<ImmutablePreparedGeneration, "sha" | "buildDigest">,
  serving: { pid: number; generationPath: string } | null,
  outcome: ImmutableGatewayObservation["outcome"],
): ImmutableGatewayObservation {
  return {
    outcome,
    phase: "readiness",
    elapsedMs: 1,
    service: syntheticImmutableServiceObservation(descriptor, serving),
    ...(outcome === "verified" && serving
      ? {
          verification: {
            pid: serving.pid,
            bootId: `boot-${serving.pid}`,
            port: 18789,
            version: "2026.10.3",
            buildId: generation.sha,
            generationSha: generation.sha,
            buildDigest: generation.buildDigest,
            healthz: 200,
            readyz: 200,
            channelsReady: true,
            pluginsReady: true,
          },
        }
      : {}),
  };
}

/** Physical pointer and SQLite fixture; only privileged ownership is projected. */
export function createImmutableActivationLayout(parent: string) {
  const root = path.join(parent, "installation");
  const currentPath = path.join(root, "releases", previousSha);
  const candidatePath = path.join(root, "releases", candidateSha);
  const schemaVersions = { state: 1, agent: 1 };
  fs.mkdirSync(currentPath, { recursive: true, mode: 0o755 });
  fs.mkdirSync(candidatePath, { mode: 0o755 });
  for (const generation of [currentPath, candidatePath]) {
    fs.writeFileSync(
      path.join(generation, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.10.3",
        openclaw: { schemaVersions },
      }),
    );
  }
  fs.symlinkSync(`releases/${previousSha}`, path.join(root, "current"));
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (
      stat &&
      (String(args[0]) === parent || String(args[0]).startsWith(`${parent}${path.sep}`))
    ) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
  if (process.geteuid) {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
  }
  const runtime = fs.realpathSync(process.execPath);
  const descriptor: ImmutableInstallDescriptor = {
    version: 2,
    activationEnabled: true,
    kind: "immutable",
    root,
    rootIdentity: identity(root),
    releasesIdentity: identity(path.join(root, "releases")),
    current: {
      sha: previousSha,
      path: currentPath,
      identity: identity(currentPath),
      pointerIdentity: identity(path.join(root, "current")),
      buildDigest: "1".repeat(64),
    },
    service: {
      unit: "immutable-fixture.service",
      scope: "system",
      account: "synthetic",
      stateDir: path.join(parent, "state"),
      configPath: path.join(parent, "state", "openclaw.json"),
      profile: null,
    },
    runtime: { path: runtime, identity: packageActivationRuntimeIdentity(runtime) },
    source: "https://github.com/openclaw/openclaw.git",
  };
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
  const protectedFile = { dev: "1", ino: "2", mode: 0o600, nlink: 1 as const, uid: 0, gid: 0 };
  const statePath = path.join(descriptor.service.stateDir, "openclaw.db");
  const protection: ImmutableProtectionSnapshot = {
    capturedAtMs: 1,
    auditBoundary: null,
    state: {
      path: statePath,
      identity: protectedFile,
      pathProof: { targetPath: statePath, entries: [] },
      key: "synthetic-state",
    },
    config: [
      {
        path: descriptor.service.configPath,
        identity: protectedFile,
        pathProof: { targetPath: descriptor.service.configPath, entries: [] },
        hash: "3".repeat(64),
        fingerprint: {},
        policyFingerprint: "4".repeat(64),
      },
    ],
  };
  return { root, descriptor, candidate, protection };
}
