import { AsyncLocalStorage } from "node:async_hooks";
import type { ConfigSnapshotPreparation } from "./io.snapshot-preparation.types.js";

type SnapshotPreparationScope = Readonly<{
  configPath: string;
  prepare: ConfigSnapshotPreparation;
  isCurrent: () => boolean;
}>;

const preparationScopes = new AsyncLocalStorage<readonly SnapshotPreparationScope[]>();

/** Bootstrap lends read preparation without claiming runtime write or activation ownership. */
export async function withConfigSnapshotPreparation<T>(
  params: { configPath: string; prepare: ConfigSnapshotPreparation },
  run: () => Promise<T>,
): Promise<T> {
  let active = true;
  const scope: SnapshotPreparationScope = { ...params, isCurrent: () => active };
  try {
    return await preparationScopes.run([...(preparationScopes.getStore() ?? []), scope], run);
  } finally {
    active = false;
  }
}

export function getScopedConfigSnapshotPreparation(
  configPath: string,
): SnapshotPreparationScope | undefined {
  return preparationScopes
    .getStore()
    ?.findLast((scope) => scope.configPath === configPath && scope.isCurrent());
}
