import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "../../daemon/runtime-pin-state.js";
import {
  resolveManagedServiceNodeRunner,
  resolveServiceEntrypoint,
} from "../../daemon/service-layout.js";
import { fingerprintGatewayServiceDefinition } from "../../daemon/service-rebind.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { tryReadJson } from "../../infra/json-files.js";
import {
  createPackageIntegrityReader,
  PackageIntegrityTimeoutError,
  PackageIntegrityLimitError,
} from "../../infra/package-update-integrity.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { defaultRuntime } from "../../runtime.js";
import { parsePackageOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { verifyPreviousGatewayForUpdate } from "./update-command-readiness.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import type {
  OriginalManagedServiceRuntime,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import { assertGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";

async function nodeIdentity(nodeRunner: string): Promise<string> {
  const real = await fs.realpath(nodeRunner);
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isFile() || stat.ino === 0n) {
    throw new Error("Original service Node identity is unavailable.");
  }
  return [
    real,
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

// These mandatory reads have their own reader, never the optional tree's exhausted deadline.
async function readOriginalServiceFiles(params: {
  root: string;
  nodeRunner: string;
  command: GatewayServiceCommandConfig | null;
  assertCurrent: () => void;
  timeoutMs?: number;
}) {
  const { root, assertCurrent } = params;
  assertCurrent();
  const reader = createPackageIntegrityReader(params.timeoutMs);
  const packageIdentity = await reader.directoryIdentity(root);
  assertCurrent();
  const launcherPath = params.command && resolveServiceEntrypoint(params.command);
  if (!packageIdentity || !launcherPath) {
    throw new Error("Original service directory or launcher identity is unavailable.");
  }
  const realPath = await fs.realpath(launcherPath);
  assertCurrent();
  const fingerprint = await reader.launcher(launcherPath);
  assertCurrent();
  const targetFingerprint = await reader.launcher(realPath);
  assertCurrent();
  const node = await nodeIdentity(params.nodeRunner);
  assertCurrent();
  const buildId = (await readBuiltGatewayBuildId(root)) ?? undefined;
  assertCurrent();
  const schemaVersions = parsePackageOpenClawSchemaVersions(
    await tryReadJson<unknown>(path.join(root, "package.json")),
  );
  assertCurrent();
  const finalIdentity = await reader.directoryIdentity(root);
  assertCurrent();
  if (!isDeepStrictEqual(finalIdentity, packageIdentity)) {
    throw new Error("Original service directory changed during mandatory reads.");
  }
  return {
    packageIdentity,
    launcher: { path: launcherPath, realPath, fingerprint, targetFingerprint },
    nodeIdentity: node,
    buildId,
    schemaVersions,
  };
}

/** The observation is data. Every use requires an independently live admitted executor. */
export function originalServiceAuthority(run: UpdateCommandOptions["run"]): () => void {
  const executor = run?.executorFence;
  if (!run || !executor) {
    throw new UpdateCommandRecoveryPendingError(
      "Original service recovery requires its admitted executor.",
    );
  }
  const authority = captureUpdateCommandExecutorAuthority(executor);
  return () => {
    if (
      run.executorFence !== executor ||
      !isDeepStrictEqual(captureUpdateCommandExecutorAuthority(executor), authority)
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Original service recovery lost its admitted executor.",
      );
    }
    executor.assertCurrent();
  };
}

export async function revalidateOriginalManagedServiceRuntime(
  original: OriginalManagedServiceRuntime,
  assertCurrent: () => void,
  timeoutMs?: number,
  allowOwnRebind = false,
) {
  assertCurrent();
  const state = await readGatewayServiceState(resolveGatewayService(), {
    env: original.service.serviceEnv,
    requireEffective: true,
    requireLoadedCommand: true,
    validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
    timeoutMs,
  });
  assertCurrent();
  const definition = await fingerprintGatewayServiceDefinition(state.command);
  assertCurrent();
  const ownRebind = allowOwnRebind && original.definition.rebound === definition;
  const runtimePin = readDaemonRuntimePinForInstall(
    { kind: "gateway", env: original.service.serviceEnv ?? {} },
    state.command,
    true,
  );
  const expectedRuntimePin = ownRebind
    ? original.definition.reboundRuntimePin
    : original.definition.runtimePin.revision;
  if (runtimePin.revision !== expectedRuntimePin) {
    throw new Error("Original managed service runtime intent changed.");
  }
  if (definition !== original.definition.fingerprint && !ownRebind) {
    throw new Error("Original managed service definition changed.");
  }
  const verifiedState = ownRebind ? { ...state, command: original.definition.command } : state;
  const verdict = await revalidateManagedGatewayServiceAfterUpdate({
    state: verifiedState,
    root: original.root,
    preManagedServiceStop: original.service,
  });
  assertCurrent();
  if (
    verdict.kind !== "owned" ||
    resolveManagedServiceNodeRunner(verifiedState.command) !== original.nodeRunner ||
    (await fs.realpath(verdict.root)) !== original.root ||
    original.version !== original.packageIdentity.version
  ) {
    throw new Error("Original managed service runtime changed; compensation was refused.");
  }
  assertCurrent();
  if (original.packageFingerprint) {
    try {
      const fingerprint = await createPackageIntegrityReader(timeoutMs).tree(original.root);
      assertCurrent();
      if (!isDeepStrictEqual(fingerprint, original.packageFingerprint)) {
        throw new Error("Original managed service package changed; compensation was refused.");
      }
    } catch (error) {
      assertCurrent();
      if (
        !(
          error instanceof PackageIntegrityTimeoutError ||
          error instanceof PackageIntegrityLimitError
        )
      ) {
        throw error;
      }
      original.packageFingerprintWarning =
        error instanceof PackageIntegrityTimeoutError
          ? `Original service full package fingerprint timed out (scan budget ${error.budgetMs} ms); full package contents are unverified. Mandatory runtime identities still require revalidation.`
          : `Original service full package fingerprint unavailable (${error.message}); full package contents are unverified. Mandatory runtime identities still require revalidation.`;
      defaultRuntime.error(original.packageFingerprintWarning);
    }
  }
  const files = await readOriginalServiceFiles({
    root: original.root,
    nodeRunner: original.nodeRunner,
    command: verifiedState.command,
    assertCurrent,
    timeoutMs,
  });
  if (
    !isDeepStrictEqual(files, {
      packageIdentity: original.packageIdentity,
      launcher: original.launcher,
      nodeIdentity: original.nodeIdentity,
      buildId: original.buildId,
      schemaVersions: original.schemaVersions,
    })
  ) {
    throw new Error("Original managed service runtime changed; compensation was refused.");
  }
  assertCurrent();
  return state;
}

export async function observeOriginalManagedServiceRuntime(
  params: { root: string; opts: UpdateCommandOptions; updateStepTimeoutMs?: number },
  before?: PreManagedServiceStop,
): Promise<OriginalManagedServiceRuntime | undefined> {
  const verdict = before?.serviceUpdateVerdict;
  if (!before?.running || before.stopped || verdict?.kind !== "owned") {
    return undefined;
  }
  const assertCurrent = originalServiceAuthority(params.opts.run);
  assertCurrent();
  try {
    const root = await fs.realpath(verdict.root);
    if (root === (await fs.realpath(params.root))) {
      return undefined;
    }
    if (process.platform === "win32") {
      throw new Error(
        "Split-root service restoration requires persistent Windows Job custody; preserve the running service until that custody is available.",
      );
    }
    if (!before.serviceNodeRunner || !before.serviceEnv) {
      throw new Error("Original service Node or manager environment is unavailable.");
    }
    assertCurrent();
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: before.serviceEnv,
      requireEffective: true,
      requireLoadedCommand: true,
      validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
      timeoutMs: params.updateStepTimeoutMs,
    });
    assertCurrent();
    const files = await readOriginalServiceFiles({
      root,
      nodeRunner: before.serviceNodeRunner,
      command: state.command,
      assertCurrent,
      timeoutMs: params.updateStepTimeoutMs,
    });
    if (!state.command) {
      throw new Error("Original service definition is unavailable.");
    }
    if (
      state.command.managedOverrides ||
      state.command.managedDefinition ||
      state.command.reloadPending
    ) {
      throw new Error(
        "Original service has overrides that cannot be restored by the canonical writer.",
      );
    }
    const definition = {
      command: structuredClone(state.command),
      runtimePin: readDaemonRuntimePin({ kind: "gateway", env: before.serviceEnv }, state.command),
      fingerprint: await fingerprintGatewayServiceDefinition(state.command),
    };
    assertCurrent();
    const original: OriginalManagedServiceRuntime = {
      root,
      nodeRunner: before.serviceNodeRunner,
      version: files.packageIdentity.version,
      verified: false,
      definition,
      // Disable refresh permission: recovery may use only this exact original definition.
      service: {
        serviceEnv: { ...before.serviceEnv },
        serviceManagerUid: before.serviceManagerUid,
        serviceUpdateVerdict: { ...verdict, root, refreshDefinition: false },
      },
      ...files,
    };
    const startedAt = performance.now();
    try {
      original.packageFingerprint = await createPackageIntegrityReader(
        params.updateStepTimeoutMs,
      ).tree(root);
      assertCurrent();
      if (
        original.packageFingerprint.identity !== files.packageIdentity.identity ||
        original.packageFingerprint.version !== files.packageIdentity.version
      ) {
        throw new Error("Original managed service package changed during observation.");
      }
    } catch (error) {
      assertCurrent();
      if (
        !(
          error instanceof PackageIntegrityTimeoutError ||
          error instanceof PackageIntegrityLimitError
        )
      ) {
        throw error;
      }
      original.packageFingerprintWarning =
        error instanceof PackageIntegrityTimeoutError
          ? `Original service full package fingerprint unavailable after ${Math.round(performance.now() - startedAt)} ms (scan budget ${error.budgetMs} ms). Compensation requires directory, version and launcher revalidation; full package contents are unverified.`
          : `Original service full package fingerprint unavailable (${error.message}). Compensation requires directory, version and launcher revalidation; full package contents are unverified.`;
      defaultRuntime.error(original.packageFingerprintWarning);
    }
    assertCurrent();
    const context = await captureTargetDatabaseSchemaContext(before.serviceEnv);
    assertCurrent();
    original.verified = await verifyPreviousGatewayForUpdate({
      root,
      config: context.config,
      env: context.env,
      opts: params.opts,
      timeoutMs: params.updateStepTimeoutMs,
      assertCurrent,
    });
    assertCurrent();
    if (!original.verified || !original.schemaVersions) {
      throw new Error("Original service readiness or schema support was not verified.");
    }
    await revalidateOriginalManagedServiceRuntime(
      original,
      assertCurrent,
      params.updateStepTimeoutMs,
    );
    return original;
  } catch (error) {
    assertCurrent();
    throw new UpdatePreMutationError(
      "original-service-unverified",
      `Cannot safely stop the retained Gateway: original service compensation could not be certified (${String(error)}). The running Gateway was not stopped; inspect its runtime before retrying the update.`,
      { cause: error },
    );
  }
}

/** Read current config and every registered/configured store, never restore pre-stop state. */
export async function assertOriginalServiceStateCompatible(
  original: OriginalManagedServiceRuntime,
  assertCurrent: () => void,
) {
  assertCurrent();
  if (
    !original.verified ||
    !original.version ||
    !original.schemaVersions ||
    !original.service.serviceEnv
  ) {
    throw new Error("Original service runtime or schema support was not verified.");
  }
  assertCurrent();
  await assertUpdateRecoveryAdmission({ env: original.service.serviceEnv });
  assertCurrent();
  const context = await captureTargetDatabaseSchemaContext(original.service.serviceEnv);
  assertCurrent();
  const schemas = await checkTargetDatabaseSchemasForContexts(original.schemaVersions, [context]);
  assertCurrent();
  if (hasSchemaRefusal(schemas)) {
    throw new Error(
      "Original service does not support the current state; candidate and newer data were retained.",
    );
  }
  return context;
}
