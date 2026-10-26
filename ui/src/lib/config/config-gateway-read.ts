import { err as failure, ok, type Result } from "@openclaw/normalization-core/result";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { configMutationFailure } from "./config-mutation-error.ts";
import {
  beginConfigRead,
  currentConfigRead,
  isCurrentConfigConnection,
  isCurrentRequest,
  type ConfigRead,
  type LoadConfigOptions,
  type RuntimeConfigState,
} from "./config-state-model.ts";

export type ConfigSnapshotLoadOptions = LoadConfigOptions & {
  background?: boolean;
  beforeApplySnapshot?: () => void;
  snapshotOwner: {
    hasUnacknowledgedDraftWrite: () => boolean;
    applySnapshot: (snapshot: ConfigSnapshot, options?: LoadConfigOptions) => void;
  };
};

function startConfigLoad(
  state: RuntimeConfigState,
  options: ConfigSnapshotLoadOptions,
  isCurrentLoad: () => boolean = () => true,
): ConfigRead | null {
  const client = state.client;
  if (!client || !state.connected || !hasOperatorReadAccess(client.auth)) {
    return null;
  }
  const read = beginConfigRead(state, client);
  void readConfig(state, read, options, isCurrentLoad).then(read.completion.resolve);
  return read;
}

export function loadConfigSnapshot(
  state: RuntimeConfigState,
  options: ConfigSnapshotLoadOptions,
  isCurrentLoad: () => boolean = () => true,
): Promise<boolean> {
  const read = startConfigLoad(state, options, isCurrentLoad);
  return read ? read.completion.promise.then((result) => result.ok) : Promise.resolve(false);
}

export async function refreshConfigSnapshotAfterMutation(
  state: RuntimeConfigState,
  options: ConfigSnapshotLoadOptions,
): Promise<Result<void, string>> {
  // A generation event can precede the RPC's final commit. Always issue a fresh
  // read here; only actual later reads can satisfy this mutation's refresh.
  let read = startConfigLoad(state, options);
  if (!read) {
    return failure("Configuration is unavailable; reconnect and try again.");
  }
  const { client, connectionEpoch } = read;
  while (true) {
    const result = await read.settled;
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return failure("Connection changed before the configuration update was refreshed.");
    }
    const latest = currentConfigRead(state);
    if (!latest) {
      return failure("The configuration refresh was superseded by a configuration write.");
    }
    if (latest === read) {
      return result;
    }
    read = latest;
  }
}

async function readConfig(
  state: RuntimeConfigState,
  { client, connectionEpoch, version }: ConfigRead,
  options: ConfigSnapshotLoadOptions,
  isCurrentLoad: () => boolean,
): Promise<Result<void, string>> {
  const isCurrent = () =>
    isCurrentLoad() && isCurrentRequest(state, version, client, connectionEpoch);
  if (!options.background) {
    state.configLoading = true;
  }
  // Foreground reads replace transient errors, but a retained draft conflict still needs resolution.
  if (
    !options.snapshotOwner.hasUnacknowledgedDraftWrite() &&
    state.configAutoSaveStatus !== "conflict" &&
    state.configAutoSaveStatus !== "rejected" &&
    (!options.background || state.configAutoSaveStatus !== "error")
  ) {
    state.lastError = null;
    state.chatError = null;
  }
  try {
    const res = await client.request<ConfigSnapshot>("config.get", {});
    if (!isCurrent()) {
      return failure("The configuration refresh was superseded.");
    }
    state.configValid = typeof res.valid === "boolean" ? res.valid : null;
    state.configIssues = Array.isArray(res.issues) ? res.issues : [];
    if (res.writeError) {
      const outcome = configMutationFailure(state, new GatewayRequestError(res.writeError));
      state.lastError = outcome.message;
      state.configAutoSaveStatus = "error";
      return failure(outcome.message);
    }
    if (state.configRecoveryError !== null && (!res.exists || !res.valid)) {
      return failure(state.configRecoveryError);
    }
    // Recovery captures the latest intent before a clean draft is replaced.
    options.beforeApplySnapshot?.();
    if (!isCurrent()) {
      return failure("The configuration refresh was superseded.");
    }
    options.snapshotOwner.applySnapshot(res, options);
    // An explicit reload reconciles a clean patch failure. Background applied-revision
    // polling must leave the rejected intent and its explanation visible.
    if (
      !options.background &&
      !state.configFormDirty &&
      !options.snapshotOwner.hasUnacknowledgedDraftWrite()
    ) {
      if (
        state.configAutoSaveStatus === "error" ||
        state.configAutoSaveStatus === "conflict" ||
        state.configAutoSaveStatus === "rejected"
      ) {
        state.configAutoSaveStatus = "idle";
      }
      state.lastError = null;
    }
    return ok(undefined);
  } catch (error) {
    if (!isCurrent()) {
      return failure("The configuration refresh was superseded.");
    }
    const outcome = configMutationFailure(state, error);
    state.lastError = outcome.message;
    if (
      state.configAutoSaveStatus === "rejected" ||
      options.snapshotOwner.hasUnacknowledgedDraftWrite()
    ) {
      state.configAutoSaveStatus = "error";
    }
    return failure(outcome.message);
  } finally {
    if (isCurrentRequest(state, version, client, connectionEpoch)) {
      state.configLoading = false;
    }
  }
}
