import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

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
