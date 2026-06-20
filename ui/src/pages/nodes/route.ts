import { html } from "lit";
import { titleForRoute, subtitleForRoute } from "../../app-navigation.ts";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import { startNodesPolling, stopNodesPolling } from "../../ui/app-polling.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import {
  loadConfig,
  removeConfigFormValue,
  saveConfig,
  updateConfigFormValue,
} from "../../ui/controllers/config.ts";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "../../ui/controllers/devices.ts";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "../../ui/controllers/exec-approvals.ts";
import { loadNodes } from "../../ui/controllers/nodes.ts";

type NodesLoadContext = { host: SettingsHost; app: SettingsAppHost };
type NodesRenderContext = { state: AppViewState };

export const page = definePage({
  id: "nodes",
  path: "/nodes",
  load: ({ app }: NodesLoadContext) =>
    Promise.all([
      loadNodes(app),
      Promise.allSettled([loadDevices(app), loadConfig(app), loadExecApprovals(app)]),
    ]).then(() => undefined),
  onEnter: ({ host }: NodesLoadContext) => {
    startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  },
  onLeave: ({ host }: NodesLoadContext) =>
    stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]),
  component: () =>
    import("../../ui/views/nodes.ts").then((module) => ({
      shell: "page" as const,
      header: true,
      render: ({ state }: NodesRenderContext) => html`
        <section class="content-header">
          <div>
            <div class="page-title">${titleForRoute("nodes")}</div>
            <div class="page-sub">${subtitleForRoute("nodes")}</div>
          </div>
        </section>
        ${module.renderNodes({
          loading: state.nodesLoading,
          nodes: state.nodes,
          devicesLoading: state.devicesLoading,
          devicesError: state.devicesError,
          devicesList: state.devicesList,
          configForm:
            state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null),
          configLoading: state.configLoading,
          configSaving: state.configSaving,
          configDirty: state.configFormDirty,
          configFormMode: state.configFormMode,
          execApprovalsLoading: state.execApprovalsLoading,
          execApprovalsSaving: state.execApprovalsSaving,
          execApprovalsDirty: state.execApprovalsDirty,
          execApprovalsSnapshot: state.execApprovalsSnapshot,
          execApprovalsForm: state.execApprovalsForm,
          execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
          execApprovalsTarget: state.execApprovalsTarget,
          execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
          onRefresh: () => void loadNodes(state),
          onDevicesRefresh: () => void loadDevices(state),
          onDeviceApprove: (requestId) => void approveDevicePairing(state, requestId),
          onDeviceReject: (requestId) => void rejectDevicePairing(state, requestId),
          onDeviceRotate: (deviceId, role, scopes) =>
            void rotateDeviceToken(state, { deviceId, role, scopes }),
          onDeviceRevoke: (deviceId, role) => void revokeDeviceToken(state, { deviceId, role }),
          onLoadConfig: () => void loadConfig(state, { discardPendingChanges: true }),
          onLoadExecApprovals: () => {
            const target =
              state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                : { kind: "gateway" as const };
            void loadExecApprovals(state, target);
          },
          onBindDefault: (nodeId) => {
            if (nodeId) {
              updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
            } else {
              removeConfigFormValue(state, ["tools", "exec", "node"]);
            }
          },
          onBindAgent: (agentIndex, nodeId) => {
            if (nodeId) {
              updateConfigFormValue(
                state,
                ["agents", "list", agentIndex, "tools", "exec", "node"],
                nodeId,
              );
            } else {
              removeConfigFormValue(state, ["agents", "list", agentIndex, "tools", "exec", "node"]);
            }
          },
          onSaveBindings: () => void saveConfig(state),
          onExecApprovalsTargetChange: (kind, nodeId) => {
            state.execApprovalsTarget = kind;
            state.execApprovalsTargetNodeId = nodeId;
            state.execApprovalsSnapshot = null;
            state.execApprovalsForm = null;
            state.execApprovalsDirty = false;
            state.execApprovalsSelectedAgent = null;
          },
          onExecApprovalsSelectAgent: (agentId) => {
            state.execApprovalsSelectedAgent = agentId;
          },
          onExecApprovalsPatch: (path, value) => updateExecApprovalsFormValue(state, path, value),
          onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(state, path),
          onSaveExecApprovals: () => {
            const target =
              state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                : { kind: "gateway" as const };
            void saveExecApprovals(state, target);
          },
        })}
      `,
    })),
});
