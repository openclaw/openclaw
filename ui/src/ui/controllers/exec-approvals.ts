import type { GatewayBrowserClient } from "../gateway";
import { cloneConfigObject, removePathValue, setPathValue } from "./config/form-utils";

export type ExecApprovalsDefaults = {
  security?: string;
  ask?: string;
  askFallback?: string;
  autoAllowSkills?: boolean;
};

export type ExecApprovalsAllowlistEntry = {
  pattern: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

export type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecApprovalsAllowlistEntry[];
};

export type ExecApprovalsFile = {
  version?: number;
  socket?: { path?: string };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

export type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

export type ExecApprovalsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  lastError: string | null;
};

export async function loadExecApprovals(state: ExecApprovalsState) {
  if (!state.client || !state.connected) return;
  if (state.execApprovalsLoading) return;
  state.execApprovalsLoading = true;
  state.lastError = null;
  try {
    const res = (await state.client.request(
      "exec.approvals.get",
      {},
    )) as ExecApprovalsSnapshot;
    applyExecApprovalsSnapshot(state, res);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.execApprovalsLoading = false;
  }
}

export function applyExecApprovalsSnapshot(
  state: ExecApprovalsState,
  snapshot: ExecApprovalsSnapshot,
) {
  state.execApprovalsSnapshot = snapshot;
  if (!state.execApprovalsDirty) {
    state.execApprovalsForm = cloneConfigObject(snapshot.file ?? {});
  }
}

export async function saveExecApprovals(state: ExecApprovalsState) {
  if (!state.client || !state.connected) return;
  state.execApprovalsSaving = true;
  state.lastError = null;
  try {
    const baseHash = state.execApprovalsSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Exec approvals hash missing; reload and retry.";
      return;
    }
    const file =
      state.execApprovalsForm ??
      state.execApprovalsSnapshot?.file ??
      {};
    await state.client.request("exec.approvals.set", { file, baseHash });
    state.execApprovalsDirty = false;
    await loadExecApprovals(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.execApprovalsSaving = false;
  }
}

export function updateExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
  value: unknown,
) {
  const base = cloneConfigObject(
    state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {},
  );
  setPathValue(base, path, value);
  state.execApprovalsForm = base;
  state.execApprovalsDirty = true;
}

export function removeExecApprovalsFormValue(
  state: ExecApprovalsState,
  path: Array<string | number>,
) {
  const base = cloneConfigObject(
    state.execApprovalsForm ?? state.execApprovalsSnapshot?.file ?? {},
  );
  removePathValue(base, path);
  state.execApprovalsForm = base;
  state.execApprovalsDirty = true;
}
