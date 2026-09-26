import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { hashConfigRaw } from "./io.read-helpers.js";
import { configWritePostCommitCapture, type ConfigWriteOptions } from "./io.types.js";
import type { ConfigFileSnapshot } from "./types.js";
export type ConfigFileWrite = {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  contiguous: boolean;
};

const fileWrites = new AsyncLocalStorage<Map<string, ConfigFileWrite>>();

/** Nested mutation flows retain one ordered ownership history. */
export function withConfigFileWriteCapture<T>(
  run: (writes: Map<string, ConfigFileWrite>) => Promise<T>,
): Promise<T> {
  const active = fileWrites.getStore();
  if (active) {
    return run(active);
  }
  const writes = new Map<string, ConfigFileWrite>();
  return fileWrites.run(writes, () => run(writes));
}

export function getConfigFileWriteCapture(): Map<string, ConfigFileWrite> | undefined {
  return fileWrites.getStore();
}

/** Hashes describe the exact bytes accepted and published by the successful writer. */
export function recordConfigFileWrite(
  filePath: string,
  beforeHash: string | null,
  afterHash: string | null,
): void {
  const writes = fileWrites.getStore();
  if (!writes) {
    return;
  }
  const absolutePath = path.resolve(filePath);
  const previous = writes.get(absolutePath);
  writes.set(absolutePath, {
    path: absolutePath,
    beforeHash: previous ? previous.beforeHash : beforeHash,
    afterHash,
    contiguous: previous ? previous.contiguous && previous.afterHash === beforeHash : true,
  });
}

/** Runtime activation decides whether a factory write remains committed. */
export function deferConfigFileWriteCapture() {
  let recordCommittedWrite: (() => void) | undefined;
  const options: Pick<ConfigWriteOptions, typeof configWritePostCommitCapture> =
    fileWrites.getStore()
      ? {
          [configWritePostCommitCapture]: (record) => {
            recordCommittedWrite = record;
          },
        }
      : {};
  return { options, record: () => recordCommittedWrite?.() };
}

export function captureCommittedConfigFileWrite(
  configPath: string,
  snapshot: Pick<ConfigFileSnapshot, "exists" | "raw">,
  nextHash: string,
  options: ConfigWriteOptions,
): void {
  if (!fileWrites.getStore() || (snapshot.exists && typeof snapshot.raw !== "string")) {
    return;
  }
  const beforeHash =
    snapshot.exists && typeof snapshot.raw === "string" ? hashConfigRaw(snapshot.raw) : null;
  const record = () => recordConfigFileWrite(configPath, beforeHash, nextHash);
  const deferCapture = options[configWritePostCommitCapture];
  if (deferCapture) {
    deferCapture(record);
  } else {
    record();
  }
}
