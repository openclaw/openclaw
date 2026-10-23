import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RuntimeConfigState } from "../../lib/config/config-state-model.ts";

export function readConfigValue(config: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((value, segment) => {
    if (Array.isArray(value) && typeof segment === "number") {
      return value[segment];
    }
    return isRecord(value) && typeof segment === "string" && Object.hasOwn(value, segment)
      ? value[segment]
      : undefined;
  }, config);
}

export function searchConfigRevision(state: Readonly<RuntimeConfigState>): string {
  const snapshot = state.configSnapshot;
  return JSON.stringify([
    snapshot?.hash ?? null,
    snapshot?.configRevisionHash ?? null,
    snapshot?.appliedConfigHash ?? null,
  ]);
}

export function isSearchConfigSettled(state: Readonly<RuntimeConfigState>): boolean {
  return (
    state.connected &&
    state.configSnapshot?.valid === true &&
    !state.configLoading &&
    !state.configSaving &&
    !state.configApplying &&
    !state.configFormDirty &&
    !state.configNeedsApply &&
    !state.configRecoveryError &&
    (state.configAutoSaveStatus === "idle" || state.configAutoSaveStatus === "saved")
  );
}
