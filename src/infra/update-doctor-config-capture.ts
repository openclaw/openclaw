// Config IO and Doctor must share a synchronous capture without loading Doctor's result protocol.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import type {
  DoctorConfigCapture,
  DoctorConfigWriteAuthority,
  UpdateDoctorConfigChange,
  UpdateDoctorConfigWriteRefusal,
} from "./update-doctor-config.js";

const doctorConfigWrites = new AsyncLocalStorage<{
  capture: DoctorConfigCapture;
  authority?: DoctorConfigWriteAuthority;
}>();

export function getUpdateDoctorConfigCapture(): DoctorConfigCapture | undefined {
  return doctorConfigWrites.getStore()?.capture;
}

export function runWithUpdateDoctorConfigCapture<T>(
  capture: DoctorConfigCapture,
  run: (capture: DoctorConfigCapture) => Promise<T>,
  authority?: DoctorConfigWriteAuthority,
): Promise<T> {
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
