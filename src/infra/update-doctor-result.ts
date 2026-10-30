import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import { formatErrorMessage } from "./errors.js";
import {
  resolvePreferredOpenClawTmpDir,
  type ResolvePreferredOpenClawTmpDirOptions,
} from "./tmp-openclaw-dir.js";
import type {
  UpdateDatabaseGenerations,
  UpdateDatabaseWriteReceipt,
} from "./update-database-generations.js";
import {
  UpdateDoctorConfigChangeSchema,
  UpdateDoctorConfigWriteRefusalSchema,
} from "./update-doctor-config-schema.js";
import type {
  UpdateDoctorConfigChange,
  UpdateDoctorConfigWriteRefusal,
} from "./update-doctor-config.js";
import { UpdateDoctorLintFindingSchema } from "./update-doctor-lint-schema.js";
import { runWithUpdateDoctorMigrationCapture } from "./update-doctor-migration-attribution.js";
import {
  createUpdateDoctorHistoricalScanCapture,
  UpdateDoctorHistoricalScansSchema,
} from "./update-doctor-scan-receipts.js";
import { normalizeUpdateFailureFacts, type UpdateFailureFact } from "./update-failure-facts.js";
import { UpdateFailureFactSchema } from "./update-run-schema.js";

// IPC contract between package update parents and the post-install doctor child.
export const UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV =
  "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH";
export const UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE = 86;
const UPDATE_POST_INSTALL_DOCTOR_RESULT_FILENAME_RE =
  /^openclaw-update-doctor-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu;

export type PackageUpdateStepAdvisory = {
  kind: "package-post-install-doctor";
  message: string;
};

export const PACKAGE_POST_INSTALL_DOCTOR_ADVISORY: PackageUpdateStepAdvisory = {
  kind: "package-post-install-doctor",
  message:
    "Post-install doctor reported a recoverable update-time repair warning after the package install was verified; continuing with post-core plugin convergence.",
};

const configHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const configFileWriteSchema = z.object({
  inputHash: configHashSchema.optional(),
  hash: configHashSchema,
});
export const UpdateDoctorDeferredInspectionCheckIdsSchema = z
  .array(UpdateDoctorLintFindingSchema.shape.checkId.max(256))
  .max(128);
const DoctorMaintenanceRefusalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deferred"),
    reason: z.enum(["coordinator-contention", "agent-database-in-use", "admission-unavailable"]),
  }),
  z.object({
    kind: z.literal("data-at-risk"),
    reason: z.enum([
      "active-mutation",
      "unreadable-state",
      "incomplete-migration",
      "gateway-state-unverified",
    ]),
  }),
]);
export type DoctorMaintenanceRefusal = z.infer<typeof DoctorMaintenanceRefusalSchema>;

const doctorResultEvidence = {
  configHash: z.union([z.literal("unchanged"), configHashSchema]).optional(),
  configInputHash: configHashSchema.optional(),
  configFileWrites: z
    .record(
      z.string().refine((filePath) => path.isAbsolute(filePath)),
      configFileWriteSchema,
    )
    .optional()
    .catch(undefined),
  warnings: z.array(z.string()).optional(),
  deferredInspectionCheckIds:
    UpdateDoctorDeferredInspectionCheckIdsSchema.optional().catch(undefined),
  maintenanceRefusal: DoctorMaintenanceRefusalSchema.optional(),
  // Invalid optional diagnostics cannot change the child's classified outcome.
  failureFacts: z.array(UpdateFailureFactSchema).catch([]).optional(),
  configChanges: z.array(UpdateDoctorConfigChangeSchema).optional(),
  configWriteRefusal: UpdateDoctorConfigWriteRefusalSchema.optional(),
  databaseWrites: z
    .object({
      unchanged: z.boolean(),
      fromGenerations: z.record(z.string(), z.string().nullable()).optional(),
      generations: z.record(z.string(), z.string().nullable()),
      historicalScans: UpdateDoctorHistoricalScansSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
};
const UpdatePostInstallDoctorResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["ok", "error"]), ...doctorResultEvidence }),
  z.object({
    status: z.literal("advisory"),
    advisory: z.object({
      kind: z.literal("package-post-install-doctor"),
      reason: z.literal("deferred-configured-plugin-repair"),
      message: z.string().transform(() => PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message),
      details: z.array(z.string().refine((detail) => detail.trim().length > 0)).min(1),
    }),
    ...doctorResultEvidence,
  }),
]);
export type UpdatePostInstallDoctorResult = z.infer<typeof UpdatePostInstallDoctorResultSchema>;

export class UpdateDoctorError extends Error {
  readonly exitCode: number | null | undefined;

  constructor(
    message: string,
    readonly failureFacts: UpdateFailureFact[],
    options?: ErrorOptions & { exitCode?: number | null },
  ) {
    super(message, options);
    this.name = "UpdateDoctorError";
    this.exitCode = options?.exitCode;
  }
}

export class DoctorMaintenanceRefusalError extends UpdateDoctorError {
  constructor(
    message: string,
    readonly refusal: DoctorMaintenanceRefusal,
    options?: ErrorOptions & { failureFacts?: UpdateFailureFact[] },
  ) {
    super(message, options?.failureFacts ?? [], options);
    this.name = "DoctorMaintenanceRefusalError";
  }
}

export function collectUpdateDoctorFailureFacts(error: unknown): UpdateFailureFact[] {
  return normalizeUpdateFailureFacts(
    collectNestedErrorCandidates(error).flatMap((candidate) =>
      candidate instanceof UpdateDoctorError ? candidate.failureFacts : [],
    ),
  );
}

/** Keep optional health diagnostics bounded across Doctor and its update parent. */
export function normalizeUpdatePostInstallDoctorWarnings(warnings: readonly string[]): string[] {
  return [
    ...new Set(
      warnings
        .map((warning) => {
          const value = warning.trim();
          if (value.length <= 500) {
            return value;
          }
          const prefix = value.slice(0, 498);
          const complete =
            prefix.match(/^[\s\S]*(?:[.!?](?=\s)|\r?\n)/u)?.[0] ??
            prefix.match(/^[^\r\n]+:(?=\s)/u)?.[0];
          return complete
            ? `${complete.trimEnd()} …`
            : "Warning detail omitted because it exceeds the display limit.";
        })
        .filter(Boolean),
    ),
  ].slice(0, 32);
}

export type DoctorConfigCapture = {
  path: string;
  hash: string;
  inputHash?: string;
  fileWrites?: Record<string, z.infer<typeof configFileWriteSchema>>;
  configChanges: UpdateDoctorConfigChange[];
  configWriteRefusal?: UpdateDoctorConfigWriteRefusal;
  deferredInspectionCheckIds?: string[];
};
/** Runs a policy check under Doctor's held maintenance owner and its open scope. */
type DoctorPolicyCustodyOwner = { assertCurrent(policy: () => void): void };
export type UpdateDoctorWriteAuthority = {
  /** An optional work profile; config preparation still proves eligibility. */
  retirementOnly?: true;
  /** Parent Doctor phase deadline for nested managed-service inspection. */
  serviceInspectionDeadlineAtMs?: number;
  inputHash: string;
  assertCurrent: () => void;
  /** Doctor lends its held maintenance owner to `assertCurrent`; see doctor-policy-custody. */
  lendPolicyCustody?: (owner: DoctorPolicyCustodyOwner | undefined) => void;
  commandAuthority?: import("./update-managed-command-custody.js").ManagedCommandProcessAuthority;
  postCoreSchemaRepair?: { runId: string; assertCurrent: () => void };
  databaseGenerations?: UpdateDatabaseGenerations;
  databasePluginOwners?: import("./database-engine/port-descriptor.js").DatabasePortPluginOwners;
  originalRecoveryCapture?: {
    runId: string;
    installRoot: string;
    ref?: import("./update-recovery-baseline-capture.js").UpdateRecoveryBaselineRef;
  };
};

/** Receipts describe the caller's existing maintenance interval without owning its lifecycle. */
export function createUpdateDoctorDatabaseWriteCapture(
  input: UpdateDatabaseGenerations | undefined,
  options: {
    env: NodeJS.ProcessEnv;
    root?: string;
    signal: AbortSignal;
    assertCurrent?: () => void;
    warn: (message: string) => void;
    pluginOwners?: import("./database-engine/port-descriptor.js").DatabasePortPluginOwners;
  },
) {
  if (!input) {
    return undefined;
  }
  let expectedGenerations: UpdateDatabaseGenerations | undefined = { ...input };
  let fromGenerations: UpdateDatabaseGenerations | undefined;
  let physical = false;
  let admitted = false;
  let unchanged = true;
  let receipt: UpdateDatabaseWriteReceipt | undefined;
  const openedSqlitePaths = new Set<string>();
  const historicalScans = createUpdateDoctorHistoricalScanCapture(options);
  const read = async () => {
    if (!expectedGenerations) {
      return undefined;
    }
    let observation: import("./update-database-generations.js").UpdateDatabaseGenerationPair;
    try {
      const { readUpdateDatabaseGenerationPairIsolated } =
        await import("./update-candidate-state.js");
      observation = await readUpdateDatabaseGenerationPairIsolated(
        Object.keys(expectedGenerations),
        options,
      );
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      options.assertCurrent?.();
      expectedGenerations = undefined;
      receipt = undefined;
      options.warn(
        `Database write verification is unavailable; automatic database restoration cannot be confirmed: ${formatErrorMessage(error)}`,
      );
      return undefined;
    }
    options.assertCurrent?.();
    return observation;
  };
  const acceptEmptyReaderTransitions = (
    observation: import("./update-database-generations.js").UpdateDatabaseGenerationPair,
  ) => {
    // Share migration admission's no-write equivalence, from this same observation.
    for (const [pathname, generation] of Object.entries(observation.committed)) {
      const alternate = observation.emptyReaderAlternates[pathname];
      if (alternate !== undefined && expectedGenerations?.[pathname] === alternate) {
        expectedGenerations[pathname] = generation;
      }
    }
  };
  return {
    get receipt() {
      return receipt;
    },
    run<T>(operation: () => T): T {
      return runWithUpdateDoctorMigrationCapture(
        {
          openedSqlitePaths,
          expected: (pathname) => expectedGenerations?.[pathname],
          assertCurrent: () => options.assertCurrent?.(),
          accept(pathname, before, after) {
            options.assertCurrent?.();
            const expected = expectedGenerations;
            if (
              !expected ||
              !Object.hasOwn(expected, pathname) ||
              (!openedSqlitePaths.has(pathname) && expected[pathname] !== before)
            ) {
              unchanged = false;
              return;
            }
            expected[pathname] = after;
          },
          refuse(message) {
            unchanged = false;
            options.warn(
              `Automatic database restoration cannot attribute migration writes: ${message}`,
            );
          },
        },
        () => historicalScans.run(operation),
      );
    },
    async admit() {
      receipt = undefined;
      historicalScans.observe(Object.keys(expectedGenerations ?? {}));
      const observation = await read();
      if (observation && expectedGenerations) {
        // Unversioned 9.33-line input is admitted only by an exact whole-inventory
        // match. From here on, every migration and settlement uses committed proof.
        if (
          !admitted &&
          !isDeepStrictEqual(observation.committed, expectedGenerations) &&
          isDeepStrictEqual(observation.physical, expectedGenerations)
        ) {
          physical = true;
          expectedGenerations = observation.committed;
        }
        admitted = true;
        const generations = observation.committed;
        historicalScans.admit(generations);
        const incoming = physical ? observation.physical : { ...expectedGenerations };
        acceptEmptyReaderTransitions(observation);
        const matches = isDeepStrictEqual(generations, expectedGenerations);
        fromGenerations ??= matches ? incoming : generations;
        // Earlier receipts or another process's writes must never become our baseline.
        unchanged &&= matches;
      }
    },
    async settle() {
      let generations: UpdateDatabaseGenerations | undefined;
      let observation: Awaited<ReturnType<typeof read>>;
      let cleanScans: ReturnType<typeof historicalScans.settle>;
      try {
        observation = await read();
        generations = observation?.committed;
      } finally {
        cleanScans = historicalScans.settle(generations);
      }
      if (generations && expectedGenerations) {
        // Like the native close receipt (#177831), this can absorb raw outside writes
        // during the update window only for databases this Doctor itself opened.
        for (const [pathname, generation] of Object.entries(generations)) {
          if (openedSqlitePaths.has(pathname)) {
            expectedGenerations[pathname] = generation;
          }
        }
        acceptEmptyReaderTransitions(observation!);
        unchanged &&= isDeepStrictEqual(generations, expectedGenerations);
        receipt = {
          unchanged,
          fromGenerations,
          generations: physical ? observation!.physical : generations,
          ...(cleanScans.length ? { historicalScans: cleanScans } : {}),
        };
      }
    },
  };
}

const doctorConfigWrites = new AsyncLocalStorage<{
  capture: DoctorConfigCapture;
  authority?: UpdateDoctorWriteAuthority;
}>();

/** Deferral requires an owned result channel, not just an inherited marker. */
export function recordUpdateDoctorDeferredInspectionChecks(
  checkIds: string[],
): string[] | undefined {
  const capture = doctorConfigWrites.getStore()?.capture;
  if (!capture) {
    return undefined;
  }
  return (capture.deferredInspectionCheckIds = UpdateDoctorDeferredInspectionCheckIdsSchema.parse([
    ...new Set([...(capture.deferredInspectionCheckIds ?? []), ...checkIds]),
  ]));
}

export function captureUpdateDoctorConfigWrites<T>(
  configPath: string,
  run: (capture: DoctorConfigCapture) => Promise<T>,
  authority?: UpdateDoctorWriteAuthority,
): Promise<T> {
  const capture: DoctorConfigCapture = {
    path: path.resolve(configPath),
    hash: "unchanged",
    configChanges: [],
  };
  return doctorConfigWrites.run(
    {
      capture,
      authority: authority
        ? { inputHash: authority.inputHash, assertCurrent: authority.assertCurrent }
        : undefined,
    },
    () => run(capture),
  );
}

/** The same authority covers include writers; only the root has a captured input hash. */
export function getUpdateDoctorConfigWriteAuthority(
  configPath: string,
): { assertCurrent: () => void; inputHash?: string } | undefined {
  const context = doctorConfigWrites.getStore();
  if (!context?.authority) {
    return undefined;
  }
  const { capture, authority } = context;
  return {
    assertCurrent: authority.assertCurrent,
    ...(capture.path === path.resolve(configPath)
      ? { inputHash: capture.hash === "unchanged" ? authority.inputHash : capture.hash }
      : {}),
  };
}

export function assertUpdateDoctorConfigInputHash(configPath: string, inputHash: string): void {
  const authority = getUpdateDoctorConfigWriteAuthority(configPath);
  if (authority?.inputHash !== undefined && authority.inputHash !== inputHash) {
    const message = "Config changed after update validation; Doctor did not promote its changes.";
    recordUpdateDoctorConfigWriteRefusal({ reason: "config-input-changed", message, keys: [] });
    throw new ConfigMutationConflictError(message, { retryable: false });
  }
}

/** Retain the validated root input and live Doctor owner through include publication. */
export async function runUpdateDoctorIncludeWrite<T>(
  configPath: string,
  inputHash: string,
  run: () => Promise<T>,
): Promise<T> {
  const context = doctorConfigWrites.getStore();
  if (!context?.authority) {
    return await run();
  }
  context.authority.assertCurrent();
  assertUpdateDoctorConfigInputHash(configPath, inputHash);
  const result = await run();
  context.authority.assertCurrent();
  return result;
}

/** Retain one contiguous chain from the writer's input through its actual publications. */
export function recordUpdateDoctorConfigFileWrite(
  configPath: string,
  inputHash: string | null,
  hash: string,
): void {
  const capture = doctorConfigWrites.getStore()?.capture;
  if (!capture) {
    return;
  }
  const resolvedPath = path.resolve(configPath);
  const write =
    capture.path === resolvedPath
      ? capture
      : ((capture.fileWrites ??= {})[resolvedPath] ??= { hash: "unchanged" });
  if (write.hash === "unchanged") {
    write.inputHash = inputHash ?? undefined;
  } else if (inputHash !== write.hash) {
    // An outside write between Doctor passes breaks ownership permanently for this run.
    delete write.inputHash;
  }
  write.hash = hash;
}

/** Pair the consumed snapshot with the serialized payload at publication, never a later read. */
export function recordUpdateDoctorConfigWrite(
  configPath: string,
  inputHash: string | null,
  hash: string,
  inputConfig: unknown,
  outputJson: string,
): void {
  recordUpdateDoctorConfigFileWrite(configPath, inputHash, hash);
  const capture = doctorConfigWrites.getStore()?.capture;
  if (capture && capture.path === path.resolve(configPath)) {
    const before = isRecord(inputConfig) ? inputConfig : {};
    const after: unknown = JSON.parse(outputJson);
    if (!isRecord(after)) {
      throw new Error("Committed Doctor config is not an object.");
    }
    const keys = new Set(
      capture.configChanges.flatMap((change) => (change.kind === "key" ? [change.key] : [])),
    );
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!isDeepStrictEqual(before[key], after[key])) {
        keys.add(key);
      }
    }
    capture.configChanges = [
      ...[...keys].toSorted().map((key): UpdateDoctorConfigChange => ({ kind: "key", key })),
      ...capture.configChanges.filter((change) => change.kind === "migration"),
    ];
  }
}

/** Record migration notes only after their matching config write has committed. */
export function recordUpdateDoctorConfigMigration(message: string): void {
  const capture = doctorConfigWrites.getStore()?.capture;
  if (
    capture &&
    message.trim() &&
    !capture.configChanges.some(
      (change) => change.kind === "migration" && change.message === message,
    )
  ) {
    capture.configChanges.push({ kind: "migration", message });
  }
}

export function recordUpdateDoctorConfigWriteRefusal(
  refusal: UpdateDoctorConfigWriteRefusal,
): void {
  const capture = doctorConfigWrites.getStore()?.capture;
  if (capture) {
    capture.configWriteRefusal ??= { ...refusal, keys: [...new Set(refusal.keys)].toSorted() };
  }
}

export function createUpdatePostInstallDoctorResultPath(
  options?: Pick<ResolvePreferredOpenClawTmpDirOptions, "tmpdir">,
): string {
  return path.join(
    resolvePreferredOpenClawTmpDir(options),
    `openclaw-update-doctor-${process.pid}-${randomUUID()}.json`,
  );
}

function resolveSafeUpdatePostInstallDoctorResultPath(
  resultPath: string,
  options?: Pick<ResolvePreferredOpenClawTmpDirOptions, "tmpdir">,
): string {
  const tempRoot = path.resolve(resolvePreferredOpenClawTmpDir(options));
  const resolvedPath = path.resolve(resultPath);
  if (
    path.dirname(resolvedPath) !== tempRoot ||
    !UPDATE_POST_INSTALL_DOCTOR_RESULT_FILENAME_RE.test(path.basename(resolvedPath))
  ) {
    throw new Error("Unsafe post-install doctor result path");
  }
  return resolvedPath;
}

export function createDeferredConfiguredPluginRepairDoctorResult(
  details: readonly string[],
): UpdatePostInstallDoctorResult {
  return {
    status: "advisory",
    advisory: {
      ...PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
      reason: "deferred-configured-plugin-repair",
      details: details.filter((line) => line.trim()),
    },
  };
}

export async function writeUpdatePostInstallDoctorResult(params: {
  resultPath: string;
  result: UpdatePostInstallDoctorResult;
}): Promise<void> {
  const result = normalizeUpdatePostInstallDoctorResult(params.result);
  if (params.resultPath === "-") {
    // Native update owners consume the final classified result after the child settles.
    const { defaultRuntime } = await import("../runtime.js");
    defaultRuntime.writeStdout(
      `${UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV}=${JSON.stringify(result)}`,
    );
    return;
  }
  const resultPath = resolveSafeUpdatePostInstallDoctorResultPath(params.resultPath);
  // Advisory details can contain config-derived IDs; pre-existing paths must fail closed.
  await fs.writeFile(resultPath, `${JSON.stringify(result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function consumeUpdatePostInstallDoctorResult(
  resultPath: string,
  options?: Pick<ResolvePreferredOpenClawTmpDirOptions, "tmpdir">,
): Promise<UpdatePostInstallDoctorResult | null> {
  let safeResultPath: string;
  try {
    safeResultPath = resolveSafeUpdatePostInstallDoctorResultPath(resultPath, options);
  } catch {
    return null;
  }
  try {
    const raw = await fs.readFile(safeResultPath, "utf8");
    return parseUpdatePostInstallDoctorResult(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    await fs.rm(safeResultPath, { force: true }).catch(() => {});
  }
}

function parseUpdatePostInstallDoctorResult(value: unknown): UpdatePostInstallDoctorResult | null {
  const parsed = UpdatePostInstallDoctorResultSchema.safeParse(value);
  return parsed.success ? normalizeUpdatePostInstallDoctorResult(parsed.data) : null;
}

function normalizeUpdatePostInstallDoctorResult({
  warnings,
  failureFacts,
  ...result
}: UpdatePostInstallDoctorResult): UpdatePostInstallDoctorResult {
  const normalizedWarnings = normalizeUpdatePostInstallDoctorWarnings(warnings ?? []);
  const facts = normalizeUpdateFailureFacts(failureFacts ?? []);
  return {
    ...result,
    ...(normalizedWarnings.length ? { warnings: normalizedWarnings } : {}),
    ...(facts.length ? { failureFacts: facts } : {}),
  };
}
