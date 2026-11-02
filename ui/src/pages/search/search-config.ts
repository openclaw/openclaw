import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WebSearchStatusResult } from "../../../../packages/gateway-protocol/src/schema/web-search.ts";
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

type SearchProviders = WebSearchStatusResult["providers"];

/** Ready providers lead; an unchanged set keeps its order so saving a key can't move the open row. */
export function keepProviderOrder(order: string[], providers: SearchProviders): string[] {
  const known = providers.length === order.length && providers.every((p) => order.includes(p.id));
  return known
    ? order
    : providers
        .toSorted(
          (a, b) =>
            Number(b.available && b.configured) - Number(a.available && a.configured) ||
            a.label.localeCompare(b.label),
        )
        .map((provider) => provider.id);
}

/** Opens the provider the operator named, or the one in use that still needs setup. */
export function providerToOpen(status: WebSearchStatusResult): string {
  const preferred = status.providers.find(
    (provider) => provider.id === (status.provider ?? status.route.provider),
  );
  return preferred && (status.provider || !preferred.available || !preferred.configured)
    ? preferred.id
    : "";
}

export function routeStatusKind(status: WebSearchStatusResult, providers: SearchProviders) {
  const { kind, provider: routed } = status.route;
  const provider = providers.find((entry) => entry.id === routed);
  // A managed route without working credentials is not a healthy route yet.
  if (kind === "managed" && provider && !(provider.available && provider.configured)) {
    return "warn";
  }
  return kind === "unavailable"
    ? "warn"
    : kind === "disabled" || kind === "external"
      ? "muted"
      : "ok";
}
