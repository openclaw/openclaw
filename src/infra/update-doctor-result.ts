import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import {
  resolvePreferredOpenClawTmpDir,
  type ResolvePreferredOpenClawTmpDirOptions,
} from "./tmp-openclaw-dir.js";
import {
  UpdateDoctorConfigChangeSchema,
  UpdateDoctorConfigWriteRefusalSchema,
} from "./update-doctor-config-schema.js";
import type {
  UpdateDoctorConfigChange,
  UpdateDoctorConfigWriteRefusal,
} from "./update-doctor-config.js";
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
const doctorResultEvidence = {
  configHash: z.union([z.literal("unchanged"), configHashSchema]).optional(),
  configInputHash: configHashSchema.optional(),
  warnings: z.array(z.string()).optional(),
  // Invalid optional diagnostics cannot change the child's classified outcome.
  failureFacts: z.array(UpdateFailureFactSchema).catch([]).optional(),
  configChanges: z.array(UpdateDoctorConfigChangeSchema).optional(),
  configWriteRefusal: UpdateDoctorConfigWriteRefusalSchema.optional(),
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
  constructor(
    message: string,
    readonly failureFacts: UpdateFailureFact[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpdateDoctorError";
  }
}

/** Keep optional health diagnostics bounded across Doctor and its update parent. */
export function normalizeUpdatePostInstallDoctorWarnings(warnings: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const warning of warnings) {
    const message = warning.trim().slice(0, 500);
    if (message) {
      normalized.push(message);
      if (normalized.length === 32) {
        break;
      }
    }
  }
  return normalized;
}

export type DoctorConfigCapture = {
  path: string;
  hash: string;
  inputHash?: string;
  configChanges: UpdateDoctorConfigChange[];
  configWriteRefusal?: UpdateDoctorConfigWriteRefusal;
};
export type UpdateDoctorWriteAuthority = { inputHash: string; assertCurrent: () => void };
const doctorConfigWrites = new AsyncLocalStorage<{
  capture: DoctorConfigCapture;
  authority?: UpdateDoctorWriteAuthority;
}>();

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

/** Include publication retains its legacy writer until fs-safe supports final-effect authority. */
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
  const result = await doctorConfigWrites.run({ capture: context.capture }, run);
  context.authority.assertCurrent();
  return result;
}

/** Pair the consumed snapshot with the serialized payload at publication, never a later read. */
export function recordUpdateDoctorConfigWrite(
  configPath: string,
  inputHash: string | null,
  hash: string,
  inputConfig: unknown,
  outputJson: string,
): void {
  const capture = doctorConfigWrites.getStore()?.capture;
  if (capture && capture.path === path.resolve(configPath)) {
    if (capture.hash === "unchanged") {
      capture.inputHash = inputHash ?? undefined;
    } else if (inputHash !== capture.hash) {
      // An outside write between Doctor passes breaks ownership permanently for this run.
      delete capture.inputHash;
    }
    capture.hash = hash;
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
  const resultPath = resolveSafeUpdatePostInstallDoctorResultPath(params.resultPath);
  const { warnings, failureFacts, ...result } = params.result;
  const normalizedWarnings = normalizeUpdatePostInstallDoctorWarnings(warnings ?? []);
  const facts = normalizeUpdateFailureFacts(failureFacts ?? []);
  // Advisory details can contain config-derived IDs; pre-existing paths must fail closed.
  await fs.writeFile(
    resultPath,
    `${JSON.stringify({
      ...result,
      ...(normalizedWarnings.length ? { warnings: normalizedWarnings } : {}),
      ...(facts.length ? { failureFacts: facts } : {}),
    })}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
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
  if (!parsed.success) {
    return null;
  }
  const { warnings, failureFacts, ...result } = parsed.data;
  const normalizedWarnings = normalizeUpdatePostInstallDoctorWarnings(warnings ?? []);
  const facts = normalizeUpdateFailureFacts(failureFacts ?? []);
  return {
    ...result,
    ...(normalizedWarnings.length ? { warnings: normalizedWarnings } : {}),
    ...(facts.length ? { failureFacts: facts } : {}),
  };
}
