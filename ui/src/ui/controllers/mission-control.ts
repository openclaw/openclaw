import type { GatewayBrowserClient } from "../gateway.ts";
import { generateUUID } from "../uuid.ts";

const NODE_DOCTOR_TIMEOUT_MS = 60_000;
const NODE_APPROVAL_TIMEOUT_MS = 120_000;

export type MissionNodeActionKind = "describe" | "probe" | "doctor";

export type MissionNodeActionResult = {
  nodeId: string;
  nodeLabel: string;
  kind: MissionNodeActionKind;
  status: "ok" | "warn" | "danger" | "info";
  title: string;
  detail: string;
  output?: string | null;
  ts: number;
};

export type PendingMissionNodeRun = {
  approvalId: string;
  nodeId: string;
  nodeLabel: string;
  command: string[];
  agentId: string | null;
  sessionKey: string | null;
};

export type MissionNodeOpsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  assistantAgentId: string | null;
  missionNodeBusyById: Record<string, MissionNodeActionKind | "approval" | null>;
  missionNodeResult: MissionNodeActionResult | null;
  missionNodePendingRuns: Record<string, PendingMissionNodeRun>;
};

type NodeRecord = Record<string, unknown>;

function setNodeBusy(
  state: MissionNodeOpsState,
  nodeId: string,
  value: MissionNodeActionKind | "approval" | null,
) {
  state.missionNodeBusyById = {
    ...state.missionNodeBusyById,
    [nodeId]: value,
  };
}

function finalizeNodeAction(
  state: MissionNodeOpsState,
  nodeId: string,
  result: MissionNodeActionResult,
) {
  setNodeBusy(state, nodeId, null);
  state.missionNodeResult = result;
}

function requireGateway(state: MissionNodeOpsState): GatewayBrowserClient {
  if (!state.client || !state.connected) {
    throw new Error("gateway not connected");
  }
  return state.client;
}

function normalizeNodeLabel(node: NodeRecord, fallbackNodeId: string): string {
  const displayName = typeof node.displayName === "string" ? node.displayName.trim() : "";
  return displayName || fallbackNodeId;
}

function resolveNodeId(node: NodeRecord): string {
  return typeof node.nodeId === "string" ? node.nodeId.trim() : "";
}

function resolveNodeCommands(node: NodeRecord): string[] {
  return Array.isArray(node.commands) ? node.commands.map((entry) => String(entry)) : [];
}

function stringifyPayload(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function resolveAgentId(state: MissionNodeOpsState) {
  return state.assistantAgentId?.trim() || "main";
}

async function invokeNode<T = unknown>(
  state: MissionNodeOpsState,
  params: {
    nodeId: string;
    command: string;
    payload?: unknown;
    timeoutMs?: number;
  },
): Promise<T> {
  const client = requireGateway(state);
  return await client.request<T>("node.invoke", {
    nodeId: params.nodeId,
    command: params.command,
    params: params.payload ?? {},
    timeoutMs: params.timeoutMs,
    idempotencyKey: generateUUID(),
  });
}

export function missionNodeSupports(node: NodeRecord, command: string) {
  return resolveNodeCommands(node).includes(command);
}

export async function describeMissionNode(state: MissionNodeOpsState, node: NodeRecord) {
  const nodeId = resolveNodeId(node);
  const nodeLabel = normalizeNodeLabel(node, nodeId);
  if (!nodeId) {
    return;
  }
  setNodeBusy(state, nodeId, "describe");
  try {
    const payload = await requireGateway(state).request<Record<string, unknown>>("node.describe", {
      nodeId,
    });
    const commands = Array.isArray(payload.commands)
      ? payload.commands.map((entry) => String(entry))
      : [];
    const caps = Array.isArray(payload.caps) ? payload.caps.map((entry) => String(entry)) : [];
    finalizeNodeAction(state, nodeId, {
      nodeId,
      nodeLabel,
      kind: "describe",
      status: payload.connected === true ? "ok" : "warn",
      title: `${nodeLabel} capabilities`,
      detail: [
        stringifyPayload(payload.platform),
        commands.length > 0 ? `commands ${commands.join(", ")}` : "no commands declared",
        caps.length > 0 ? `caps ${caps.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      output: stringifyPayload(payload.pathEnv)
        ? `PATH ${stringifyPayload(payload.pathEnv)}`
        : null,
      ts: Date.now(),
    });
  } catch (err) {
    finalizeNodeAction(state, nodeId, {
      nodeId,
      nodeLabel,
      kind: "describe",
      status: "danger",
      title: `${nodeLabel} describe failed`,
      detail: String(err),
      output: null,
      ts: Date.now(),
    });
  }
}

export async function probeMissionNode(state: MissionNodeOpsState, node: NodeRecord) {
  const nodeId = resolveNodeId(node);
  const nodeLabel = normalizeNodeLabel(node, nodeId);
  if (!nodeId) {
    return;
  }
  setNodeBusy(state, nodeId, "probe");
  try {
    const payload = await invokeNode<{ payload?: { bins?: Record<string, string> } }>(state, {
      nodeId,
      command: "system.which",
      payload: { bins: ["openclaw", "git", "node"] },
      timeoutMs: 8_000,
    });
    const bins = payload?.payload?.bins ?? {};
    const found = Object.entries(bins);
    finalizeNodeAction(state, nodeId, {
      nodeId,
      nodeLabel,
      kind: "probe",
      status: found.length > 0 ? "ok" : "warn",
      title: `${nodeLabel} probe`,
      detail:
        found.length > 0
          ? `${found.length} expected binary path(s) resolved on node`
          : "The node responded, but no expected binaries were resolved.",
      output:
        found.length > 0
          ? found.map(([name, path]) => `${name}: ${path}`).join("\n")
          : "bins: none",
      ts: Date.now(),
    });
  } catch (err) {
    finalizeNodeAction(state, nodeId, {
      nodeId,
      nodeLabel,
      kind: "probe",
      status: "danger",
      title: `${nodeLabel} probe failed`,
      detail: String(err),
      output: null,
      ts: Date.now(),
    });
  }
}

function upsertPendingMissionRun(state: MissionNodeOpsState, pending: PendingMissionNodeRun) {
  state.missionNodePendingRuns = {
    ...state.missionNodePendingRuns,
    [pending.approvalId]: pending,
  };
}

function deletePendingMissionRun(state: MissionNodeOpsState, approvalId: string) {
  const next = { ...state.missionNodePendingRuns };
  delete next[approvalId];
  state.missionNodePendingRuns = next;
}

async function runMissionNodeDoctorOnce(
  state: MissionNodeOpsState,
  pending: PendingMissionNodeRun,
  approvalDecision?: "allow-once" | "allow-always",
) {
  return await invokeNode<{ payload?: Record<string, unknown> }>(state, {
    nodeId: pending.nodeId,
    command: "system.run",
    payload: {
      command: pending.command,
      timeoutMs: NODE_DOCTOR_TIMEOUT_MS,
      agentId: pending.agentId ?? undefined,
      sessionKey: pending.sessionKey ?? undefined,
      ...(approvalDecision
        ? {
            runId: pending.approvalId,
            approved: true,
            approvalDecision,
          }
        : {}),
    },
    timeoutMs: NODE_DOCTOR_TIMEOUT_MS + 10_000,
  });
}

function formatDoctorOutput(payload: Record<string, unknown> | undefined): {
  status: "ok" | "warn" | "danger";
  detail: string;
  output: string | null;
} {
  const stdout = typeof payload?.stdout === "string" ? payload.stdout.trim() : "";
  const stderr = typeof payload?.stderr === "string" ? payload.stderr.trim() : "";
  const error = typeof payload?.error === "string" ? payload.error.trim() : "";
  const exitCode = typeof payload?.exitCode === "number" ? payload.exitCode : null;
  const timedOut = payload?.timedOut === true;
  const success = payload?.success === true;
  const output = [stdout, stderr, error].filter(Boolean).join("\n\n").trim() || null;
  if (success) {
    return {
      status: "ok",
      detail:
        exitCode == null
          ? "Doctor completed successfully."
          : `Doctor completed with exit code ${exitCode}.`,
      output,
    };
  }
  if (timedOut) {
    return {
      status: "danger",
      detail: "Doctor command timed out on the node.",
      output,
    };
  }
  return {
    status: "danger",
    detail:
      exitCode == null ? "Doctor command failed." : `Doctor failed with exit code ${exitCode}.`,
    output,
  };
}

export async function runMissionNodeDoctor(state: MissionNodeOpsState, node: NodeRecord) {
  const nodeId = resolveNodeId(node);
  const nodeLabel = normalizeNodeLabel(node, nodeId);
  if (!nodeId) {
    return;
  }
  if (Object.values(state.missionNodePendingRuns).some((entry) => entry.nodeId === nodeId)) {
    state.missionNodeResult = {
      nodeId,
      nodeLabel,
      kind: "doctor",
      status: "info",
      title: `${nodeLabel} doctor pending`,
      detail: "An approval request is already waiting for this node.",
      output: null,
      ts: Date.now(),
    };
    setNodeBusy(state, nodeId, "approval");
    return;
  }
  setNodeBusy(state, nodeId, "doctor");
  const pending: PendingMissionNodeRun = {
    approvalId: generateUUID(),
    nodeId,
    nodeLabel,
    command: ["openclaw", "doctor", "--non-interactive"],
    agentId: resolveAgentId(state),
    sessionKey: state.sessionKey?.trim() || "main",
  };
  try {
    const raw = await runMissionNodeDoctorOnce(state, pending);
    const formatted = formatDoctorOutput(raw?.payload);
    finalizeNodeAction(state, nodeId, {
      nodeId,
      nodeLabel,
      kind: "doctor",
      title: `${nodeLabel} doctor`,
      detail: formatted.detail,
      output: formatted.output,
      status: formatted.status,
      ts: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("SYSTEM_RUN_DENIED: approval required")) {
      await requireGateway(state).request("exec.approval.request", {
        id: pending.approvalId,
        command: pending.command.join(" "),
        host: "node",
        agentId: pending.agentId,
        sessionKey: pending.sessionKey,
        timeoutMs: NODE_APPROVAL_TIMEOUT_MS,
        twoPhase: true,
      });
      upsertPendingMissionRun(state, pending);
      setNodeBusy(state, nodeId, "approval");
      state.missionNodeResult = {
        nodeId,
        nodeLabel,
        kind: "doctor",
        status: "info",
        title: `${nodeLabel} doctor waiting`,
        detail: "Approval requested. Allow the queued exec request to run the node doctor.",
        output: pending.command.join(" "),
        ts: Date.now(),
      };
      return;
    }
    finalizeNodeAction(state, nodeId, {
      nodeId,
      nodeLabel,
      kind: "doctor",
      status: "danger",
      title: `${nodeLabel} doctor failed`,
      detail: message,
      output: null,
      ts: Date.now(),
    });
  }
}

export async function resumeMissionNodeRun(
  state: MissionNodeOpsState,
  approvalId: string,
  decision: "allow-once" | "allow-always" | "deny",
) {
  const pending = state.missionNodePendingRuns[approvalId];
  if (!pending) {
    return false;
  }
  if (decision === "deny") {
    deletePendingMissionRun(state, approvalId);
    finalizeNodeAction(state, pending.nodeId, {
      nodeId: pending.nodeId,
      nodeLabel: pending.nodeLabel,
      kind: "doctor",
      status: "warn",
      title: `${pending.nodeLabel} doctor denied`,
      detail: "The operator denied the node doctor command.",
      output: pending.command.join(" "),
      ts: Date.now(),
    });
    return true;
  }
  setNodeBusy(state, pending.nodeId, "doctor");
  try {
    const raw = await runMissionNodeDoctorOnce(state, pending, decision);
    const formatted = formatDoctorOutput(raw?.payload);
    finalizeNodeAction(state, pending.nodeId, {
      nodeId: pending.nodeId,
      nodeLabel: pending.nodeLabel,
      kind: "doctor",
      title: `${pending.nodeLabel} doctor`,
      detail: formatted.detail,
      output: formatted.output,
      status: formatted.status,
      ts: Date.now(),
    });
  } catch (err) {
    finalizeNodeAction(state, pending.nodeId, {
      nodeId: pending.nodeId,
      nodeLabel: pending.nodeLabel,
      kind: "doctor",
      status: "danger",
      title: `${pending.nodeLabel} doctor failed`,
      detail: String(err),
      output: null,
      ts: Date.now(),
    });
  } finally {
    deletePendingMissionRun(state, approvalId);
  }
  return true;
}
