import type { MullusiConfig } from "./types.js";

export type RuntimeConfigSnapshotRefreshParams = {
  sourceConfig: MullusiConfig;
};

export type RuntimeConfigSnapshotRefreshHandler = {
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};

let runtimeConfigSnapshot: MullusiConfig | null = null;
let runtimeConfigSourceSnapshot: MullusiConfig | null = null;
let runtimeConfigSnapshotRefreshHandler: RuntimeConfigSnapshotRefreshHandler | null = null;

export function setRuntimeConfigSnapshot(
  config: MullusiConfig,
  sourceConfig?: MullusiConfig,
): void {
  runtimeConfigSnapshot = config;
  runtimeConfigSourceSnapshot = sourceConfig ?? null;
}

export function resetConfigRuntimeState(): void {
  runtimeConfigSnapshot = null;
  runtimeConfigSourceSnapshot = null;
}

export function clearRuntimeConfigSnapshot(): void {
  resetConfigRuntimeState();
}

export function getRuntimeConfigSnapshot(): MullusiConfig | null {
  return runtimeConfigSnapshot;
}

export function getRuntimeConfigSourceSnapshot(): MullusiConfig | null {
  return runtimeConfigSourceSnapshot;
}

export function setRuntimeConfigSnapshotRefreshHandler(
  refreshHandler: RuntimeConfigSnapshotRefreshHandler | null,
): void {
  runtimeConfigSnapshotRefreshHandler = refreshHandler;
}

export function getRuntimeConfigSnapshotRefreshHandler(): RuntimeConfigSnapshotRefreshHandler | null {
  return runtimeConfigSnapshotRefreshHandler;
}
