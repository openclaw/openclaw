/** Systemd service-definition authority and atomic, cross-process publication. */
import { randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { resolveStateDir } from "../config/paths.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { hasErrnoCode } from "../infra/errno.js";
import { withFileLock } from "../infra/file-lock.js";
import { canonicalPathFromExistingAncestor, findExistingAncestor } from "../infra/fs-safe.js";
import {
  readServiceFileState,
  type GatewayServiceDefinitionTransactionHooks,
} from "./service-stage.js";
import {
  assertServiceDefinitionWritable,
  type GatewayServiceEnv,
  type GatewayServiceReadOptions,
  type ServiceDefinitionMutationArtifact,
  type ServiceDefinitionMutationCapability,
  type SystemdServiceReadBinding,
  type SystemdServiceReadTarget,
} from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  GatewayServiceAuthorityError,
  withGatewayServiceInstallationRecovery,
} from "./service-update-authority.js";
import { execSystemctlUser, readSystemctlDetail } from "./systemd-exec.js";
import { assertNoSystemGatewayOwnership } from "./systemd-scope.js";
import {
  isNodeSystemdEnvironment,
  readSystemdServiceExecStart,
  resolveSystemdEnvironmentFilePath,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";
import { assertNoSystemSystemdOwnership, isSystemSystemdOwnershipError } from "./systemd-system.js";
import { splitSystemdLogicalLines } from "./systemd-unit.js";

type Snapshot = { contents: Buffer; mode: number } | null;
type SystemdDefinitionMutation = {
  snapshots: Map<string, Snapshot>;
  publish: (file: string, contents: string | Buffer, mode: number) => Promise<void>;
  restore: (file: string, snapshot: Snapshot) => Promise<boolean>;
  restoreAll: () => Promise<boolean>;
  remove: (file: string) => Promise<void>;
};
const identity = (stat: Stats, contents?: Buffer) =>
  [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, contents && sha256Hex(contents)].join(":");

function resolveMutationTargets(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv,
  target?: SystemdServiceReadTarget,
) {
  const unit = target?.unitPath ?? resolveSystemdUnitPath(env);
  const generated = resolveSystemdEnvironmentFilePath({
    stateDir: resolveStateDir({ ...env, ...environment }),
    environment,
  });
  return { unit, generated };
}

async function readStableFile(
  file: string,
  stat: Stats,
  requireReplacement: boolean,
): Promise<{ contents: Buffer } | { sealed: true }> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || identity(opened) !== identity(stat)) {
      throw new Error("changed artifact");
    }
    if (requireReplacement && process.platform === "linux") {
      // fdinfo selects the opened file's actual mount, including stacked mounts.
      // W_OK alone misses read-only mounts when DAC denies an otherwise replaceable 0400 file.
      const fdinfo = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
      const mountId = /^mnt_id:\s+(\d+)$/m.exec(fdinfo)?.[1];
      const mount = (await fs.readFile("/proc/self/mountinfo", "utf8"))
        .split("\n")
        .find((line) => mountId && line.startsWith(`${mountId} `))
        ?.split(" ");
      if (!mount?.[4] || !mount[5]) {
        throw new Error("Cannot inspect the service artifact mount.");
      }
      if (
        mount[5].split(",").includes("ro") ||
        decodeMountInfoPath(mount[4]) === (await fs.realpath(file))
      ) {
        return { sealed: true };
      }
    }
    return { contents: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function inspect(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv,
  options?: GatewayServiceReadOptions,
) {
  const { unit, generated } = resolveMutationTargets(env, environment, options?.systemdReadTarget);
  const snapshots = new Map<string, Snapshot>();
  const fingerprint = new Map<string, string>();
  let shared = new Set<string>();
  let sourcePath: string | undefined;
  let artifactPath: string | undefined;
  const result = (capability: ServiceDefinitionMutationCapability) => ({
    capability:
      capability.kind !== "writable" && capability.artifact === "service-file" && artifactPath
        ? { ...capability, path: artifactPath }
        : capability,
    snapshots,
    fingerprint,
    shared,
    sourcePath,
  });
  let artifact: ServiceDefinitionMutationArtifact | undefined;
  try {
    const command = await readSystemdServiceExecStart(env, {
      ...options,
      requireEffective: true,
    });
    sourcePath = command?.sourcePath;
    const targets = new Set([unit, generated, `${unit}.bak`]);
    const definitions = new Set(command?.definitionPaths ?? []);
    // Type-wide service.d defaults are shared read-only inputs. Selected fragments
    // and unit-specific overrides still require authority; never shadow a sealed unit.
    shared = new Set(
      [...definitions].filter(
        (file) =>
          file !== command?.sourcePath &&
          !targets.has(file) &&
          path.basename(path.dirname(file)) === "service.d",
      ),
    );
    const definitionParents = new Set(
      [...definitions].filter((file) => !shared.has(file)).map(path.dirname),
    );
    const parents = new Set([path.dirname(unit), path.dirname(generated), ...definitionParents]);
    const artifacts = new Set([...parents, ...targets, ...definitions]);
    for (const file of artifacts) {
      const directory = parents.has(file) && !definitions.has(file);
      const required = definitions.has(file) || definitionParents.has(file);
      artifact = !directory
        ? "service-file"
        : file === path.dirname(unit)
          ? "service-directory"
          : file === path.dirname(generated)
            ? "state-directory"
            : "definition-directory";
      const inspected =
        directory && !required ? ((await findExistingAncestor(file)) ?? file) : file;
      artifactPath = inspected;
      const stat = await fs.lstat(inspected).catch((error: unknown) => {
        if (required || !hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      });
      if (!stat) {
        fingerprint.set(file, "missing");
        continue;
      }
      // systemd retains lexical directory aliases; fingerprint both alias and target.
      if (!directory && stat.isSymbolicLink()) {
        return result({ kind: "unknown", reason: "symlink", artifact });
      }
      const actual = directory && stat.isSymbolicLink() ? await fs.stat(inspected) : stat;
      if (!shared.has(file) && actual.uid !== process.geteuid?.()) {
        return result({ kind: "sealed", reason: "foreign-owner", artifact });
      }
      if (directory && !actual.isDirectory()) {
        return result({ kind: "unknown", reason: "invalid-artifact", artifact });
      }
      if (actual.mode & 0o022) {
        return result({ kind: "unknown", reason: "unsafe-permissions", artifact });
      }
      if (directory) {
        await fs.access(inspected, constants.W_OK | constants.X_OK);
        fingerprint.set(file, `${inspected}:${identity(stat)}:${identity(actual)}`);
        continue;
      }
      const snapshot = await readStableFile(file, stat, !shared.has(file));
      if ("sealed" in snapshot) {
        return result({ kind: "sealed", reason: "sealed-mount", artifact });
      }
      const { contents } = snapshot;
      fingerprint.set(file, identity(stat, contents));
      if (targets.has(file)) {
        snapshots.set(file, { contents, mode: stat.mode & 0o777 });
      }
    }
    return result({ kind: "writable" });
  } catch (error) {
    if (error instanceof GatewayServiceAuthorityError) {
      throw error;
    }
    return result({ kind: "unknown", reason: "inspection-failed", artifact });
  }
}

export async function readSystemdDefinitionMutationCapability(
  env: GatewayServiceEnv,
  options?: {
    environment?: GatewayServiceEnv;
    timeoutMs?: number;
    requireLoaded?: boolean;
    systemdReadBinding?: SystemdServiceReadBinding;
    systemdReadTarget?: SystemdServiceReadTarget;
  },
): Promise<ServiceDefinitionMutationCapability> {
  if (options?.systemdReadTarget?.scope === "system") {
    return { kind: "sealed", reason: "system-owned" };
  }
  const selected =
    options?.systemdReadTarget?.unitName ?? path.basename(resolveSystemdUnitPath(env));
  const { environment = env, ...readOptions } = options ?? {};
  const names =
    selected === "openclaw-gateway.service" ? [selected, "openclaw.service"] : [selected];
  const budget =
    options?.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : options?.requireLoaded
        ? 5000
        : undefined;
  const deadlineAt = budget === undefined ? undefined : performance.now() + budget;
  const remaining = () => {
    if (deadlineAt === undefined) {
      return undefined;
    }
    const value = deadlineAt - performance.now();
    if (value <= 0) {
      throw new Error("Definition inspection deadline expired.");
    }
    return value;
  };
  for (const name of names) {
    try {
      await assertNoSystemSystemdOwnership(
        name,
        remaining(),
        ...(options?.requireLoaded ? [{ requireLoaded: true }] : []),
      );
    } catch (error) {
      const owned =
        isSystemSystemdOwnershipError(error) && error.ownership.status !== "unverifiable";
      if (owned) {
        return { kind: "sealed", reason: "system-owned" };
      }
      const unverified = { kind: "unknown", reason: "system-ownership-unverified" } as const;
      // A loaded user unit whose artifacts this account owns is the manager in
      // charge; an unreachable system manager cannot make it a competing owner.
      if (!options?.requireLoaded || !isSystemSystemdOwnershipError(error)) {
        return unverified;
      }
      const loaded = await inspect(env, environment, {
        ...readOptions,
        timeoutMs: remaining(),
        requireLoaded: true,
      }).then(
        (inspection) => inspection.capability,
        () => undefined,
      );
      return loaded?.kind === "writable" ? loaded : unverified;
    }
  }
  try {
    return (await inspect(env, environment, { ...readOptions, timeoutMs: remaining() })).capability;
  } catch {
    return { kind: "unknown", reason: "inspection-failed" };
  }
}

export async function withSystemdDefinitionMutation<T>(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv,
  run: (mutation: SystemdDefinitionMutation) => Promise<T>,
  options?: {
    timeoutMs?: number;
    definitionTransaction?: GatewayServiceDefinitionTransactionHooks;
    warn?: (message: string) => void;
  },
): Promise<T> {
  const deadlineAt =
    options?.timeoutMs && options.timeoutMs > 0 ? performance.now() + options.timeoutMs : undefined;
  const remainingTimeoutMs = () =>
    deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - performance.now());
  const { unit, generated } = resolveMutationTargets(env, environment);
  const canonicalTargets = () =>
    Promise.all([unit, generated].map(canonicalPathFromExistingAncestor));
  const preparation = await withGatewayServiceInstallationRecovery(
    async () => {
      const initial = await inspect(env, environment, { timeoutMs: remainingTimeoutMs() });
      assertServiceDefinitionWritable(initial.capability);
      // Group-writable umasks must not create directories that inspect() would reject.
      assertGatewayServiceUpdateCurrent();
      await fs.mkdir(path.dirname(unit), { recursive: true, mode: 0o755 });
      assertGatewayServiceUpdateCurrent();
      await fs.mkdir(path.dirname(generated), { recursive: true, mode: 0o700 });
      return { initial, lockedTargets: await canonicalTargets() };
    },
    async () => false,
  );
  let initial = preparation.initial;
  const { lockedTargets } = preparation;
  const targets = lockedTargets
    .map((target) => path.join(path.dirname(target), `.openclaw-${sha256Hex(target)}`))
    .toSorted();
  const execute = async (): Promise<T> => {
    const refresh = async (unchanged = false, firstUnitPublication = false) => {
      const current = await inspect(env, environment, { timeoutMs: remainingTimeoutMs() });
      assertServiceDefinitionWritable(current.capability);
      const expected = new Map(initial.fingerprint);
      // LoadUnit can reveal shared defaults only after the first base publication.
      // Admit only new shared inputs; every observed artifact must still match exactly.
      if (firstUnitPublication && !initial.sourcePath && current.sourcePath === unit) {
        for (const [file, fingerprint] of current.fingerprint) {
          if (current.shared.has(file) && !expected.has(file)) {
            expected.set(file, fingerprint);
          }
        }
      }
      if (unchanged && !isDeepStrictEqual(current.fingerprint, expected)) {
        throw new Error("Managed service artifacts changed during publication.");
      }
      initial = current;
    };
    await withGatewayServiceInstallationRecovery(
      async () => {
        await refresh();
        // Waiting may admit another writer's artifacts, never another directory's locks.
        if (!isDeepStrictEqual(await canonicalTargets(), lockedTargets)) {
          throw new Error("Managed service lock targets changed during acquisition.");
        }
      },
      async () => false,
    );
    const allowed = new Set([unit, generated, `${unit}.bak`]);
    const snapshots = initial.snapshots;
    const publications = new Map<string, string>();
    let reloadPending = false;
    const reloadRestoredDefinition = async () => {
      if (!reloadPending) {
        return;
      }
      try {
        await assertNoSystemGatewayOwnership(env, remainingTimeoutMs());
        assertGatewayServiceUpdateCurrent();
        const result = await execSystemctlUser(
          env,
          ["daemon-reload"],
          remainingTimeoutMs(),
          assertGatewayServiceUpdateCurrent,
        );
        assertGatewayServiceUpdateCurrent();
        if (result.code !== 0 || result.termination !== "exit") {
          throw new Error(
            `systemctl rollback daemon-reload failed: ${readSystemctlDetail(result)}`,
          );
        }
        reloadPending = false;
      } catch (error) {
        const message = `Systemd rollback reload was not confirmed; service inputs including ${generated} were retained. Retry service installation from the same profile after the user manager is available.`;
        options?.warn?.(message);
        throw new Error(message, { cause: error });
      }
    };
    const publish = async (
      file: string,
      contents: string | Buffer,
      mode: number,
      rollback = true,
    ) => {
      if (!allowed.has(file)) {
        throw new Error("Not a managed service publication target.");
      }
      await options?.definitionTransaction?.beforeWrite();
      await refresh(true);
      const previous = initial.snapshots.get(file) ?? null;
      await readServiceFileState(file);
      await refresh(true);
      const directory = await fs.realpath(path.dirname(file));
      const temporary = path.join(directory, `${path.basename(file)}.${randomUUID()}.tmp`);
      try {
        // Keep owner-write during preparation so the descriptor can be reopened
        // even when the final snapshot mode is read-only.
        assertGatewayServiceUpdateCurrent();
        await fs.writeFile(temporary, contents, { flag: "wx", mode: mode | 0o200 });
        const temporaryHandle = await fs.open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          // Creation mode is filtered by umask. Apply the admitted mode through
          // the already-open inode so rollback restores the exact snapshot mode.
          await temporaryHandle.chmod(mode);
        } finally {
          await temporaryHandle.close();
        }
        const written = await fs.lstat(temporary);
        if (file === unit || file === generated) {
          await options?.definitionTransaction?.filePrepared(file, temporary);
        }
        await refresh(true);
        // Locks coordinate OpenClaw writers, not external editors: POSIX rename
        // has no expected-inode check. Quiesce administrative edits during installation.
        assertGatewayServiceUpdateCurrent();
        options?.definitionTransaction?.assertCurrent();
        await fs.rename(temporary, file);
        reloadPending ||= file === unit;
        // Re-read every artifact against this inode/payload. Canonical temp paths
        // keep cleanup in the original directory even if the publication alias moves.
        const published = identity(written, Buffer.from(contents));
        initial.fingerprint.set(file, published);
        publications.set(file, published);
        const recordPublication = async () => {
          await refresh(true, file === unit && previous === null);
          const after = await readServiceFileState(file);
          if (
            !after ||
            after.dev !== written.dev ||
            after.ino !== written.ino ||
            after.sha256 !== sha256Hex(Buffer.from(contents)) ||
            after.mode !== mode
          ) {
            throw new Error("Managed service artifact changed after publication.");
          }
          await refresh(true);
          if (file === unit || file === generated) {
            await options?.definitionTransaction?.fileWritten(file, contents);
          }
        };
        // Receipt recovery owns ordering across files; standalone rollback must not recurse.
        if (options?.definitionTransaction) {
          await recordPublication();
        } else {
          await withGatewayServiceInstallationRecovery(recordPublication, async () =>
            rollback ? restore(file, previous) : false,
          );
        }
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
    };
    const remove = async (file: string) => {
      if (file !== generated) {
        throw new Error("Only a generated environment file can be retired during restoration.");
      }
      await options?.definitionTransaction?.beforeWrite();
      await refresh(true);
      await options?.definitionTransaction?.filePrepared(file, null);
      assertGatewayServiceUpdateCurrent();
      options?.definitionTransaction?.assertCurrent();
      await fs.unlink(file);
      initial.fingerprint.set(file, "missing");
      await options?.definitionTransaction?.fileWritten(file, null);
      await refresh(true);
    };
    const restore = async (file: string, snapshot: Snapshot) => {
      if (!allowed.has(file) && snapshot) {
        throw new Error("Not a managed service publication target.");
      }
      const published = publications.get(file);
      if (published === undefined) {
        return false;
      }
      const current = await inspect(env, environment, { timeoutMs: remainingTimeoutMs() });
      // A refreshed global snapshot never grants ownership of another artifact's edit.
      if (current.capability.kind !== "writable" || current.fingerprint.get(file) !== published) {
        return false;
      }
      const currentUnit = current.snapshots.get(unit);
      const originalUnit = snapshots.get(unit);
      if (
        file === generated &&
        snapshot === null &&
        currentUnit &&
        (!originalUnit || !currentUnit.contents.equals(originalUnit.contents)) &&
        splitSystemdLogicalLines(currentUnit.contents.toString("utf8")).some((line) =>
          /^\s*EnvironmentFile\s*=\s*\S/u.test(line),
        )
      ) {
        throw new Error(
          `Managed service unit changed during publication and may still reference ${file}; retained for inspection.`,
        );
      }
      initial = current;
      if (snapshot) {
        await publish(file, snapshot.contents, snapshot.mode, false);
      } else if (file === generated) {
        // Disk restoration does not invalidate systemd's cached candidate definition.
        await reloadRestoredDefinition();
        await remove(file);
      } else {
        await refresh(true);
        assertGatewayServiceUpdateCurrent();
        await fs.unlink(file);
        initial.fingerprint.set(file, "missing");
        await refresh(true);
      }
      publications.delete(file);
      return true;
    };
    return await run({
      snapshots,
      publish,
      restore,
      restoreAll: async () => {
        let restored = false;
        let failure: Error | undefined;
        const files = [unit, `${unit}.bak`, ...(isNodeSystemdEnvironment(env) ? [] : [generated])];
        // Restore existing inputs, then reload their restored unit before retiring new inputs.
        // A superseded artifact is preserved; a failed unit restore still owns its references.
        const order = files.toSorted(
          (a, b) =>
            (a === unit ? 1 : snapshots.has(a) ? 0 : 2) -
            (b === unit ? 1 : snapshots.has(b) ? 0 : 2),
        );
        for (const file of order) {
          try {
            restored = (await restore(file, snapshots.get(file) ?? null)) || restored;
            if (file === unit) {
              await reloadRestoredDefinition();
            }
          } catch (error) {
            if (file === unit || (file === generated && snapshots.has(generated))) {
              throw error;
            }
            failure ??= toErrorObject(error, "Systemd rollback failed.");
          }
        }
        if (failure) {
          throw failure;
        }
        if (files.some((file) => publications.has(file))) {
          throw new Error(
            "Managed service artifacts changed during publication; recovery remains pending.",
          );
        }
        return restored;
      },
      remove,
    });
  };
  const lockOptions = () => {
    const timeoutMs = remainingTimeoutMs();
    return {
      stale: 60_000,
      retries: {
        retries: timeoutMs === undefined ? 100 : Math.max(0, Math.ceil(timeoutMs / 50) - 1),
        factor: 1,
        minTimeout: 50,
        maxTimeout: 100,
      },
    };
  };
  const acquire = async (index: number): Promise<T> =>
    index === targets.length
      ? execute()
      : withFileLock(targets[index]!, lockOptions(), () => acquire(index + 1));
  return await acquire(0);
}
