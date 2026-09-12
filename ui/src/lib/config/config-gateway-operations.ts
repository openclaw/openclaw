import { ErrorCodes } from "@openclaw/gateway-client/browser";
import { err as failure, ok, type Result } from "@openclaw/normalization-core/result";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../clipboard.ts";
import { serializeConfigForm } from "../config-form-utils.ts";
import { formatUiError, formatUiExternalText } from "../format-error.ts";
import { showToast } from "../toast.ts";
import {
  adoptConfigWriteAck,
  configFormForSubmit,
  assertConfigDraftCurrent,
  type ConfigSubmittedDraft,
  applyConfigSnapshot,
  formatConfigMutationError,
  serializeFormForSubmit,
  type ConfigWriteAck,
} from "./config-draft-model.ts";
import {
  beginConfigRead,
  currentConfigRead,
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
  isCurrentRequest,
  nextRequestVersion,
  resolveEditableSnapshotConfig,
  type ConfigRead,
  type ConfigGatewayClient,
  type LoadConfigOptions,
  type RuntimeConfigState,
} from "./config-state-model.ts";

function comparableSnapshotRaw(snapshot: RuntimeConfigState["configSnapshot"]): string | null {
  if (typeof snapshot?.raw === "string") {
    return snapshot.raw;
  }
  const editable = resolveEditableSnapshotConfig(snapshot);
  return editable ? serializeConfigForm(editable) : null;
}

export async function refreshDraft(
  state: RuntimeConfigState,
  refreshConnectionState: () => Promise<boolean>,
  publish: () => void,
  reconcileAppliedRefresh: () => void,
): Promise<void> {
  const previousRaw =
    state.configFormMode === "form" && state.configFormDirty
      ? comparableSnapshotRaw(state.configSnapshot)
      : null;
  const client = state.client;
  const epoch = currentConfigConnectionEpoch(state);
  const loaded = await refreshConnectionState();
  if (
    loaded &&
    client &&
    isCurrentConfigConnection(state, client, epoch) &&
    previousRaw !== null &&
    comparableSnapshotRaw(state.configSnapshot) === previousRaw
  ) {
    // Upgrade/restart may replace the public revision token without changing
    // the redacted base. A changed or unavailable base must still conflict.
    state.configDraftBaseHash = state.configSnapshot?.hash ?? state.configDraftBaseHash;
    publish();
  }
  reconcileAppliedRefresh();
}

/**
 * Gateway contract: requireConfigBaseHash in
 * src/gateway/server-methods/config.ts rejects writes whose baseHash no
 * longer matches the file with exactly this message. A conflict means another
 * writer changed openclaw.json; retrying the whole-form draft would clobber
 * their edit, so callers surface a reload affordance instead.
 */
function isConfigBaseHashConflictError(err: unknown): boolean {
  const message = formatUiError(err);
  return message.includes("config changed since last load");
}

function isDefinitiveConfigMutationRejection(err: unknown): boolean {
  return (
    err instanceof GatewayRequestError &&
    (err.gatewayCode === ErrorCodes.INVALID_REQUEST || err.gatewayCode === ErrorCodes.FORBIDDEN)
  );
}

export type ConfigPatchOptions = {
  raw: string | Record<string, unknown>;
  note: string;
  /** Array paths the caller intentionally shrinks; required by the gateway's destructive-array guard. */
  replacePaths?: string[];
  /** Caller-owned lifecycle/access guard, rechecked at the final dispatch boundary. */
  canDispatch?: () => boolean;
};

export type ConfigPatchBuildResult = { options: ConfigPatchOptions } | { error: string };
export type ConfigPatchBuilder = (
  config: Readonly<Record<string, unknown>>,
) => ConfigPatchBuildResult;
// Gateway commitGatewayConfigWrite returns persisted hashes; only a no-op patch omits one.
export type ConfigPatchAck =
  | { noop: true; config: Record<string, unknown> }
  | (ConfigWriteAck & { noop?: false });

export type RuntimeConfigExternalMutationResult<T> =
  | {
      ok: true;
      value: T;
      refresh: { ok: true } | { ok: false; error: string };
    }
  | {
      ok: false;
      reason: "conflict" | "error" | "rejected" | "suspended" | "unavailable";
      error: string;
    };

export type RuntimeConfigExternalMutationOptions<T = unknown> = {
  waitForWritesResumed?: boolean;
  canDispatch?: () => boolean;
  dispatchError?: string;
  /** Refresh only responses that changed configuration, such as completed device authorization. */
  shouldRefresh?: (value: T) => boolean;
  /** Select the persisted receipt for independent config.set/config.patch writes. */
  configWriteAck?: (value: T) => ConfigPatchAck;
};

export type RuntimeConfigDispatchOptions = {
  canDispatch?: () => boolean;
};

export type ConfigMethod =
  | "config.set"
  | "config.apply"
  | "config.patch"
  | "config.openFile"
  | "config.schema";

export type ConfigWriteCoordinator = {
  prepareDiscard: () => Promise<void>;
  patchForm: (path: Array<string | number>, value: unknown) => void;
  removeFormValue: (path: Array<string | number>) => void;
  setRaw: (value: string) => void;
  resetDraft: () => void;
  discardDraft: () => Promise<void>;
  setWritesSuspended: (suspended: boolean, refreshAdmission?: () => Promise<void>) => void;
  waitForPendingWrites: () => Promise<void>;
  save: (options?: RuntimeConfigDispatchOptions) => Promise<boolean>;
  retry: () => Promise<boolean>;
  apply: () => Promise<boolean>;
  stageDefaultAgent: (agentId: string) => boolean;
  patch: (options: ConfigPatchOptions) => Promise<boolean>;
  patchFromSnapshot: (build: ConfigPatchBuilder) => Promise<boolean>;
  runExternalMutation: <T>(
    task: (client: GatewayBrowserClient) => Promise<T>,
    options?: RuntimeConfigExternalMutationOptions<T>,
  ) => Promise<RuntimeConfigExternalMutationResult<T>>;
  dispose: () => void;
};

export async function executeConfigExternalMutation<T>(
  state: RuntimeConfigState,
  client: GatewayBrowserClient,
  connectionEpoch: number,
  task: (client: GatewayBrowserClient) => Promise<T>,
  options: RuntimeConfigExternalMutationOptions<T>,
  refresh: () => Promise<Result<void, string>>,
  onSubmitted?: ConfigSubmissionObserver,
): Promise<RuntimeConfigExternalMutationResult<T>> {
  if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
    return {
      ok: false,
      reason: "unavailable",
      error: "Connection changed before the configuration update started.",
    };
  }
  if (options.canDispatch && !options.canDispatch()) {
    return {
      ok: false,
      reason: "unavailable",
      error: options.dispatchError ?? "Access changed before the configuration update started.",
    };
  }
  const submitted = {
    raw: state.configFormDirty ? state.configRawOriginal : serializeFormForSubmit(state),
    form: state.configFormOriginal,
    independentSnapshot: state.configSnapshot,
  };
  let value: T;
  try {
    value = await task(client);
  } catch (error) {
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return {
        ok: false,
        reason: "unavailable",
        error: "Connection changed before the configuration update completed.",
      };
    }
    return {
      ok: false,
      reason: isConfigBaseHashConflictError(error)
        ? "conflict"
        : isDefinitiveConfigMutationRejection(error)
          ? "rejected"
          : "error",
      error: formatUiError(error),
    };
  }
  const refreshFailure = (error: string): RuntimeConfigExternalMutationResult<T> => ({
    ok: true,
    value,
    refresh: { ok: false, error },
  });
  try {
    const receipt = options.configWriteAck?.(value);
    if (receipt && receipt.noop !== true) {
      onSubmitted?.({ ...submitted, ack: receipt });
      if (isCurrentConfigConnection(state, client, connectionEpoch)) {
        adoptConfigWriteAck(state, submitted, receipt);
      }
    }
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return refreshFailure("Connection changed before the configuration update was refreshed.");
    }
    if (receipt?.noop !== true && options.shouldRefresh && !options.shouldRefresh(value)) {
      return { ok: true, value, refresh: { ok: true } };
    }
    const refreshed = await refresh();
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return refreshFailure("Connection changed before the configuration update was refreshed.");
    }
    if (!refreshed.ok) {
      return refreshFailure(refreshed.error);
    }
    if (receipt?.noop === true) {
      // A no-op has no write revision. Reconcile only the source admitted by
      // the read owner, without invalidating its successors as a new write.
      const snapshot = state.configSnapshot;
      const config = resolveEditableSnapshotConfig(snapshot);
      if (!config || !snapshot?.hash) {
        throw new Error("Config hash missing; refresh and retry.");
      }
      adoptConfigWriteAck(
        state,
        {
          raw: state.configRawOriginal,
          form: state.configFormOriginal,
          independentSnapshot: snapshot,
        },
        { config, hash: snapshot.hash },
        { raw: snapshot.raw },
      );
    }
    return { ok: true, value, refresh: { ok: true } };
  } catch (error) {
    return refreshFailure(formatUiError(error));
  }
}

type ConfigLoadOptions = LoadConfigOptions & {
  background?: boolean;
  beforeApplySnapshot?: () => void;
};

function startConfigLoad(
  state: RuntimeConfigState,
  options: ConfigLoadOptions = {},
  isCurrentLoad: () => boolean = () => true,
): ConfigRead | null {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  const read = beginConfigRead(state, client);
  void readConfig(state, read, options, isCurrentLoad).then(read.completion.resolve);
  return read;
}

export function loadConfig(
  state: RuntimeConfigState,
  options: ConfigLoadOptions = {},
  isCurrentLoad: () => boolean = () => true,
): Promise<boolean> {
  const read = startConfigLoad(state, options, isCurrentLoad);
  return read ? read.completion.promise.then((result) => result.ok) : Promise.resolve(false);
}

export async function refreshConfigAfterMutation(
  state: RuntimeConfigState,
): Promise<Result<void, string>> {
  // A generation event can precede the RPC's final commit. Always issue a fresh
  // read here; only actual later reads can satisfy this mutation's refresh.
  let read = startConfigLoad(state);
  if (!read) {
    return failure("Configuration is unavailable; reconnect and try again.");
  }
  const { client, connectionEpoch } = read;
  while (true) {
    const result = await Promise.race([read.completion.promise, read.invalidated.promise]);
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return failure("Connection changed before the configuration update was refreshed.");
    }
    const latest = currentConfigRead(state);
    if (!latest || !isCurrentRequest(state, "config", latest.version, client, connectionEpoch)) {
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
  options: ConfigLoadOptions,
  isCurrentLoad: () => boolean,
): Promise<Result<void, string>> {
  const isCurrent = () =>
    isCurrentLoad() && isCurrentRequest(state, "config", version, client, connectionEpoch);
  if (!options.background) {
    state.configLoading = true;
  }
  if (state.configAutoSaveStatus !== "error" && state.configAutoSaveStatus !== "conflict") {
    state.lastError = null;
    state.chatError = null;
  }
  try {
    const res = await client.request<ConfigSnapshot>("config.get", {});
    if (!isCurrent()) {
      return failure("The configuration refresh was superseded.");
    }
    // Recovery captures the latest intent before a clean draft is replaced.
    options.beforeApplySnapshot?.();
    if (!isCurrent()) {
      return failure("The configuration refresh was superseded.");
    }
    applyConfigSnapshot(state, res, options);
    // An explicit reload reconciles a clean patch failure. Background applied-revision
    // polling must leave the rejected intent and its explanation visible.
    if (!options.background && !state.configFormDirty) {
      if (state.configAutoSaveStatus === "error" || state.configAutoSaveStatus === "conflict") {
        state.configAutoSaveStatus = "idle";
      }
      state.lastError = null;
    }
    return ok(undefined);
  } catch (error) {
    const message = formatUiError(error);
    if (isCurrent()) {
      state.lastError = message;
    }
    return failure(message);
  } finally {
    if (
      !options.background &&
      isCurrentRequest(state, "config", version, client, connectionEpoch)
    ) {
      state.configLoading = false;
    }
  }
}

export async function loadConfigSchema(state: RuntimeConfigState) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.configSchemaLoading) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const version = nextRequestVersion(state, "schema");
  state.configSchemaLoading = true;
  try {
    const res = await client.request<ConfigSchemaResponse>("config.schema", {});
    if (!isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      return;
    }
    applyConfigSchema(state, res);
  } catch (err) {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.lastError = formatUiError(err);
    }
  } finally {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.configSchemaLoading = false;
    }
  }
}

function applyConfigSchema(state: RuntimeConfigState, res: ConfigSchemaResponse) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

export type ConfigSubmission = ConfigSubmittedDraft & { ack: ConfigWriteAck | null };
export type ConfigSubmissionObserver = (submission: ConfigSubmission) => void;

export async function submitConfigDraft(
  state: RuntimeConfigState,
  mode: "auto" | "save" | "apply",
  onSubmitted?: ConfigSubmissionObserver,
  canDispatch: () => boolean = () => true,
): Promise<boolean> {
  const client = state.client;
  const canSubmitDraft = () =>
    mode !== "auto" || (state.configFormDirty && state.configFormMode === "form");
  if (!client || !state.connected || !canSubmitDraft()) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  const busyKey = mode === "auto" ? null : mode === "apply" ? "configApplying" : "configSaving";
  // Manual writes claim busy before parsing; autosave leaves editors interactive.
  if (busyKey) {
    state[busyKey] = true;
    state.lastError = null;
    state.chatError = null;
  }
  let submittedFormRaw: string | null = null;
  try {
    if (state.configRawOriginalParsePending) {
      // JSON5 originals load lazily; capture the submitted bytes only afterward.
      await state.configRawOriginalParsePending;
    }
    if (!isCurrent() || !canSubmitDraft()) {
      return false;
    }
    assertConfigDraftCurrent(state);
    const raw = serializeFormForSubmit(state);
    const submitted = { raw, form: configFormForSubmit(state), independentSnapshot: null };
    submittedFormRaw = state.configFormMode === "form" ? raw : null;
    const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      if (mode === "auto") {
        state.configAutoSaveStatus = "error";
      }
      return false;
    }
    if (!canDispatch()) {
      return false;
    }
    if (mode === "auto") {
      state.configAutoSaveStatus = "saving";
      state.lastError = null;
      state.chatError = null;
    }
    // Dispatch bytes let reconnect recognize a committed write whose ack was lost.
    onSubmitted?.({ ...submitted, ack: null });
    const ack = await client.request<ConfigWriteAck>(
      mode === "apply" ? "config.apply" : "config.set",
      { raw, baseHash, ...(mode === "apply" ? { sessionKey: state.applySessionKey } : {}) },
    );
    // Report before the epoch fence: teardown can flush against this flight's ack.
    onSubmitted?.({ ...submitted, ack });
    if (!isCurrent()) {
      return false;
    }
    adoptConfigWriteAck(state, submitted, ack);
    state.configNeedsApply = mode !== "apply";
    // Manual writes refresh resolved values and applied revision truth. Autosave
    // already has its authoritative hash and must not lock editors with a reload.
    if (mode !== "auto") {
      await loadConfig(state);
      if (!isCurrent()) {
        return false;
      }
    }
    if (mode !== "apply" && state.configAutoSaveStatus !== "conflict") {
      state.configAutoSaveStatus = state.configFormDirty ? "idle" : "saved";
    }
    return true;
  } catch (err) {
    if (isCurrent()) {
      state.lastError = formatConfigMutationError(err, submittedFormRaw);
      if (isConfigBaseHashConflictError(err)) {
        state.configAutoSaveStatus = "conflict";
      } else if (mode !== "apply") {
        state.configAutoSaveStatus = "error";
      }
    }
    return false;
  } finally {
    if (busyKey && isCurrent()) {
      state[busyKey] = false;
    }
  }
}

/**
 * Teardown flush after an in-flight save: submits the latest draft once,
 * replaying edits on that flight's canonical acknowledgement. Callers skip
 * the flush when no acknowledgement exists.
 */
export function teardownFlushConfigDraft(
  state: RuntimeConfigState,
  client: GatewayBrowserClient,
  submitted: ConfigSubmittedDraft,
  ack: ConfigWriteAck,
  canDispatch: () => boolean,
): void {
  adoptConfigWriteAck(state, submitted, ack);
  if (!canDispatch() || !state.configFormDirty) {
    return;
  }
  try {
    assertConfigDraftCurrent(state);
  } catch (error) {
    state.lastError = formatUiError(error);
    state.configAutoSaveStatus = isConfigBaseHashConflictError(error) ? "conflict" : "error";
    return;
  }
  const draft = {
    raw: serializeFormForSubmit(state),
    form: configFormForSubmit(state),
    independentSnapshot: null,
  };
  void client
    .request<ConfigWriteAck>("config.set", { raw: draft.raw, baseHash: ack.hash })
    .then((receipt) => adoptConfigWriteAck(state, draft, receipt))
    .catch(() => undefined);
}

export async function patchConfig(
  state: RuntimeConfigState,
  options: ConfigPatchOptions,
  onSubmitted?: ConfigSubmissionObserver,
): Promise<boolean> {
  const client = state.client;
  const currentSnapshot = state.configSnapshot;
  if (!client || !state.connected || !currentSnapshot) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const baseHash = currentSnapshot.hash;
  const currentConfig = resolveEditableSnapshotConfig(currentSnapshot);
  if (!baseHash || !currentConfig) {
    state.lastError = "Config hash missing; refresh and retry.";
    state.configAutoSaveStatus = "conflict";
    return false;
  }
  if (options.canDispatch && !options.canDispatch()) {
    return false;
  }
  const draftStatus = state.configFormDirty ? state.configAutoSaveStatus : "idle";
  const submitted = {
    raw: state.configRawOriginal,
    form: state.configFormOriginal,
    independentSnapshot: currentSnapshot,
  };
  state.configAutoSaveStatus = "saving";
  state.lastError = null;
  state.chatError = null;
  try {
    const ack = await client.request<ConfigPatchAck>("config.patch", {
      baseHash,
      raw: typeof options.raw === "string" ? options.raw : JSON.stringify(options.raw),
      sessionKey: state.applySessionKey,
      note: options.note,
      ...(options.replacePaths?.length ? { replacePaths: options.replacePaths } : {}),
    });
    const receipt = {
      config: ack.noop === true ? currentConfig : ack.config,
      hash: ack.noop === true ? baseHash : ack.hash,
    };
    onSubmitted?.({ ...submitted, ack: receipt });
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return false;
    }
    const adoptedStatus = adoptConfigWriteAck(state, submitted, receipt, {
      raw: ack.noop === true ? currentSnapshot.raw : undefined,
    });
    if (ack.noop !== true) {
      // The commit is authoritative; polling config.get reconciles applied truth.
      state.configNeedsApply = true;
    }
    state.configAutoSaveStatus =
      adoptedStatus === "conflict"
        ? "conflict"
        : state.configFormDirty && draftStatus === "paused"
          ? "paused"
          : state.configFormDirty
            ? "idle"
            : "saved";
    return true;
  } catch (err) {
    if (isCurrentConfigConnection(state, client, connectionEpoch)) {
      state.lastError = formatUiError(err);
      state.configAutoSaveStatus = isConfigBaseHashConflictError(err) ? "conflict" : "error";
    }
    return false;
  }
}

export async function lookupConfigSchemaPath(
  state: { client: ConfigGatewayClient | null; connected: boolean },
  path: string,
): Promise<unknown> {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  try {
    const result = await client.request("config.schema.lookup", { path });
    return isCurrentConfigConnection(state, client, connectionEpoch) ? result : null;
  } catch (error) {
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return null;
    }
    throw error;
  }
}

export async function openConfigFile(state: RuntimeConfigState): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  state.lastError = null;
  state.chatError = null;
  const publishFailure = async (error: string, path?: string | null) => {
    if (!isCurrent()) {
      return;
    }
    let message = error;
    if (path) {
      message += (await copyToClipboard(path))
        ? `\n\nFile path copied to clipboard: ${path}`
        : `\n\nFile path: ${path}`;
    }
    if (isCurrent()) {
      state.lastError = formatUiExternalText(message);
      showToast({ message: state.lastError });
    }
  };
  try {
    const res = await client.request<{ ok: boolean; path?: string; error?: string }>(
      "config.openFile",
      {},
    );
    if (!isCurrent()) {
      return;
    }
    if (!res.ok) {
      await publishFailure(
        formatUiExternalText(res.error, "Failed to open config file"),
        res.path || state.configSnapshot?.path,
      );
      return;
    }
    showToast({ message: t("configView.fileOpenedOnGateway") });
  } catch (err) {
    await publishFailure(formatUiError(err), state.configSnapshot?.path);
  }
}
