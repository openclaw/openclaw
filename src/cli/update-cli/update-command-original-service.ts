import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { tryReadJson } from "../../infra/json-files.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { defaultRuntime } from "../../runtime.js";
import { parsePackageOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import {
  inspectGatewayRestart,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import type {
  OriginalManagedServiceRuntime,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";
import {
  gatewayServiceCommandUsesRoot,
  resolveUpdatedGatewayRestartPort,
  assertGatewayServiceManagementAllowedForUpdate,
  resolveManagedServiceNodeRunner,
} from "./update-command-service-plan.js";

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
  const verdict = await revalidateManagedGatewayServiceAfterUpdate({
    state,
    root: original.root,
    preManagedServiceStop: original.service,
  });
  assertCurrent();
  if (
    verdict.kind !== "owned" ||
    resolveManagedServiceNodeRunner(state.command) !== original.nodeRunner ||
    (await fs.realpath(verdict.root)) !== original.root ||
    (await nodeIdentity(original.nodeRunner)) !== original.nodeIdentity ||
    !isDeepStrictEqual(
      await createPackageIntegrityReader(timeoutMs).tree(original.root),
      original.packageFingerprint,
    )
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
  if (
    !before?.running ||
    before.stopped ||
    !before.serviceNodeRunner ||
    !before.serviceEnv ||
    verdict?.kind !== "owned" ||
    !params.opts.run?.executorFence
  ) {
    return undefined;
  }
  const assertCurrent = originalServiceAuthority(params.opts.run);
  assertCurrent();
  try {
    const root = await fs.realpath(verdict.root);
    if (root === (await fs.realpath(params.root))) {
      return undefined;
    }
    const original: OriginalManagedServiceRuntime = {
      root,
      nodeRunner: before.serviceNodeRunner,
      version: null,
      verified: false,
      // Disable refresh permission: recovery may use only this exact original definition.
      service: {
        serviceEnv: { ...before.serviceEnv },
        serviceManagerUid: before.serviceManagerUid,
        serviceUpdateVerdict: { ...verdict, root, refreshDefinition: false },
      },
      packageFingerprint: await createPackageIntegrityReader(params.updateStepTimeoutMs).tree(root),
      nodeIdentity: await nodeIdentity(before.serviceNodeRunner),
    };
    original.version = original.packageFingerprint.version;
    original.buildId = (await readBuiltGatewayBuildId(root)) ?? undefined;
    original.schemaVersions = parsePackageOpenClawSchemaVersions(
      await tryReadJson<unknown>(path.join(root, "package.json")),
    );
    assertCurrent();
    const context = await captureTargetDatabaseSchemaContext(before.serviceEnv);
    assertCurrent();
    original.verified = await verifyPreviousGateway({
      root,
      config: context.config,
      env: context.env,
      run: undefined,
    });
    assertCurrent();
    await revalidateOriginalManagedServiceRuntime(
      original,
      assertCurrent,
      params.updateStepTimeoutMs,
    );
    return original;
  } catch (error) {
    assertCurrent();
    defaultRuntime.error(
      `Original service compensation could not be certified: ${String(error)}. Forward update remains available.`,
    );
    return undefined;
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

async function verifyPreviousGateway(params: {
  root: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  run: UpdateCommandOptions["run"];
}): Promise<boolean> {
  const { root, config, env, run } = params;
  const port = await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env });
  const [expectedVersion, expectedBuildId] = await Promise.all([
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
  ]);
  const [health, readiness, servesPreviousPackage] = await Promise.all([
    inspectGatewayRestart({
      service: resolveGatewayService(),
      env,
      port,
      expectedVersion,
      expectedBuildId: expectedBuildId ?? undefined,
      requirePluginHealth: false,
    }),
    waitForGatewayHttpReadiness({
      config,
      port,
      deadlineAt: Date.now() + 3_000,
      attempts: 1,
      delayMs: 0,
    }),
    gatewayServiceCommandUsesRoot({ root, env }),
  ]);
  const verified = Boolean(
    expectedVersion &&
    servesPreviousPackage === true &&
    health.healthy &&
    health.runtime.status === "running" &&
    readiness.readyz === 200,
  );
  if (run) {
    recordUpdateRunStep(
      run.runId,
      {
        step: "previous gateway verification",
        status: "completed",
        detail: verified
          ? "Previous package is running and ready."
          : "Previous gateway was not verified; automatic rollback cannot restart it.",
        endedAtMs: Date.now(),
      },
      { env: run.env },
    );
  }
  return verified;
}
