import { AsyncLocalStorage } from "node:async_hooks";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { sha256Hex } from "../infra/crypto-digest.js";
import { readServiceFileState } from "./service-stage.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

export type GatewayServiceRebindReceipt = { before: string; after: string };
type RebindCapture = { before: string; active: boolean; receipt?: GatewayServiceRebindReceipt };
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
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(before)) {
    throw new Error("Invalid original definition binding.");
  }
  const capture: RebindCapture = { before, active: true };
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
): Promise<T> {
  const capture = captures.getStore();
  if (!capture) {
    return await mutate(false);
  }
  if (!capture.active || capture.receipt) {
    throw new Error("Original service rebind interval is closed.");
  }
  const before = await fingerprintGatewayServiceDefinition(await read());
  assertCurrent();
  if (before !== capture.before) {
    throw new Error("Original service definition changed before rebind.");
  }
  try {
    return await mutate(true);
  } finally {
    assertCurrent();
    const after = await fingerprintGatewayServiceDefinition(await read());
    assertCurrent();
    capture.receipt = { before, after };
  }
}
