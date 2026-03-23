import fs from "node:fs";
import path from "node:path";

// AGENT_BOT_COMPAT: persisted runtime state for control-plane bootstrap/sync.

type JsonObject = Record<string, unknown>;

export type ControlPlaneRuntimeRole = "training" | "serving";

export type ControlPlaneConversationView = "training" | "serving";

export type ControlPlaneDeploymentSource = "sync" | "release";

export type ControlPlaneRuntimeAgent = {
  agentId: string;
  name?: string;
  remoteAgentId: string;
  localAgentKey?: string;
  workspaceKey?: string;
  agentVersionId?: string;
  skillSnapshotId?: string;
  runtimeRole?: ControlPlaneRuntimeRole;
  sessionViews?: ControlPlaneConversationView[];
  deploymentSource?: ControlPlaneDeploymentSource;
  releaseId?: string;
  releaseVersion?: string;
  releaseStatus?: string;
  releaseManifest?: JsonObject;
  releaseFileCount?: number;
  deployedAt?: string;
  exportedAt?: string;
  status?: string;
  updatedAt: string;
};

export type ControlPlaneSkillSnapshotState = {
  snapshotId: string;
  appliedAt: string;
  packages: Array<{
    skillKey: string;
    type?: string;
    status?: string;
    remoteSkillKey?: string;
  }>;
};

export type ControlPlaneRuntimeState = {
  workgroupId?: string;
  workgroupName?: string;
  instanceId?: string;
  instanceKey?: string;
  machineName?: string;
  runtimeRole?: ControlPlaneRuntimeRole;
  sessionViews?: ControlPlaneConversationView[];
  remoteAgentId?: string;
  skillSnapshotId?: string;
  agentVersion?: string;
  portalUserRole?: string;
  traceContext?: string;
  bundleDir?: string;
  manifestPath?: string;
  agents?: ControlPlaneRuntimeAgent[];
  skillSnapshot?: ControlPlaneSkillSnapshotState;
};

const defaultStateFile = path.join(process.cwd(), ".openclaw", "control-plane-state.json");

function resolveStateFilePath(): string {
  const raw = process.env.OPENCLAW_CONTROL_PLANE_STATE_FILE?.trim();
  return raw ? path.resolve(raw) : defaultStateFile;
}

function ensureStateDir(): void {
  fs.mkdirSync(path.dirname(resolveStateFilePath()), { recursive: true });
}

export function loadControlPlaneRuntimeState(): ControlPlaneRuntimeState {
  try {
    const raw = fs.readFileSync(resolveStateFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as ControlPlaneRuntimeState;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveControlPlaneRuntimeState(
  next: ControlPlaneRuntimeState,
): ControlPlaneRuntimeState {
  ensureStateDir();
  fs.writeFileSync(resolveStateFilePath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function mergeControlPlaneRuntimeState(
  patch: Partial<ControlPlaneRuntimeState>,
): ControlPlaneRuntimeState {
  const current = loadControlPlaneRuntimeState();
  const next: ControlPlaneRuntimeState = {
    ...current,
    ...patch,
  };
  if (patch.agents) {
    next.agents = patch.agents;
  }
  if (patch.skillSnapshot) {
    next.skillSnapshot = patch.skillSnapshot;
  }
  return saveControlPlaneRuntimeState(next);
}
