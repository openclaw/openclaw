import { AsyncLocalStorage } from "node:async_hooks";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { sha256Hex } from "../infra/crypto-digest.js";
import { readServiceFileState } from "./service-stage.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

export type GatewayServiceRebindReceipt = {
  before: string;
  after: string;
  /** This receiver observed its rewrite, even if installer compensation restored A. */
  mutated?: true;
  runtimePinBefore?: string;
  runtimePinAfter?: string;
};
type RebindCapture = {
  before: string;
  runtimePinBefore?: string;
  active: boolean;
  mutated?: true;
  refresh?: (assertCurrent: () => void) => Promise<void>;
  receipt?: GatewayServiceRebindReceipt;
};
const captures = new AsyncLocalStorage<RebindCapture>();

/** Content/identity evidence only. Neither a digest nor a receipt grants mutation authority. */
export async function fingerprintGatewayServiceDefinition(
  command: GatewayServiceCommandConfig | null,
): Promise<string> {
  if (!command) {
    throw new Error("Managed service definition is unavailable.");
  }
  const paths = [
    ...new Set([
      ...(command.definitionPaths ?? []),
      ...(command.sourcePath ? [command.sourcePath] : []),
    ]),
  ].toSorted();
  const files = await Promise.all(
    paths.map(async (file) => ({ path: file, state: await readServiceFileState(file) })),
  );
  if (files.some((file) => !file.state)) {
    throw new Error("Managed service definition disappeared.");
  }
  return sha256Hex(stableStringify({ command, files }));
}

/** Installed only inside an admitted receiver's live executor, never from a saved receipt. */
export async function withGatewayServiceRebindCapture<T>(
  before: string,
  operation: () => Promise<T>,
  runtimePinBefore?: string,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(before)) {
    throw new Error("Invalid original definition binding.");
  }
  if (runtimePinBefore !== undefined && !/^[a-f0-9]{64}$/.test(runtimePinBefore)) {
    throw new Error("Invalid original runtime intent binding.");
  }
  const capture: RebindCapture = { before, runtimePinBefore, active: true };
  try {
    return await captures.run(capture, operation);
  } finally {
    capture.active = false;
  }
}

export function currentGatewayServiceRebindReceipt(): GatewayServiceRebindReceipt | undefined {
  const capture = captures.getStore();
  return capture?.active ? capture.receipt : undefined;
}

/** Called under the final native operation lock, including the failing-install path. */
export async function captureGatewayServiceRebind<T>(
  read: () => Promise<GatewayServiceCommandConfig | null>,
  assertCurrent: () => void,
  mutate: (preserveAutoStart: boolean) => Promise<T>,
  readRuntimePinRevision?: () => string,
): Promise<T> {
  const capture = captures.getStore();
  if (!capture) {
    return await mutate(false);
  }
  if (!capture.active || capture.refresh) {
    throw new Error("Original service rebind interval is closed.");
  }
  const before = await fingerprintGatewayServiceDefinition(await read());
  assertCurrent();
  if (before !== capture.before) {
    throw new Error("Original service definition changed before rebind.");
  }
  const runtimePinBefore = readRuntimePinRevision?.();
  assertCurrent();
  if (capture.runtimePinBefore !== undefined && runtimePinBefore !== capture.runtimePinBefore) {
    throw new Error("Original runtime intent changed before rebind.");
  }
  capture.refresh = async (assertFinalCurrent) => {
    // A failed read must never leave an earlier pre-compensation receipt usable.
    capture.receipt = undefined;
    if (!capture.active) {
      throw new Error("Original service rebind interval is closed.");
    }
    assertFinalCurrent();
    const after = await fingerprintGatewayServiceDefinition(await read());
    assertFinalCurrent();
    const runtimePinAfter = readRuntimePinRevision?.();
    assertFinalCurrent();
    if (after !== before || runtimePinAfter !== runtimePinBefore) {
      capture.mutated = true;
    }
    capture.receipt = {
      before,
      after,
      ...(capture.mutated ? { mutated: true } : {}),
      ...(runtimePinBefore !== undefined ? { runtimePinBefore, runtimePinAfter } : {}),
    };
  };
  try {
    return await mutate(true);
  } finally {
    await capture.refresh(assertCurrent);
  }
}

/** The installer may compensate outside the inner service writer. Observe its
 * final definition under the surrounding native lock, before emitting a receipt. */
export async function settleGatewayServiceRebind<T>(
  assertCurrent: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  const capture = captures.getStore();
  if (!capture) {
    return await operation();
  }
  const [outcome] = await Promise.allSettled([operation()]);
  try {
    await capture.refresh?.(assertCurrent);
  } catch (error) {
    if (outcome.status === "rejected") {
      throw new AggregateError(
        [outcome.reason, error],
        "Service rebind settlement could not be verified.",
        { cause: error },
      );
    }
    throw error;
  }
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}
