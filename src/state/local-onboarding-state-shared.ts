import path from "node:path";
import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "../infra/crypto-digest.js";

export type LocalOnboardingState = {
  version: 1;
  status: "pending" | "completed";
  runId: string;
  configPath: string;
  workspace: string;
  teamCoordinatorId?: string;
  securityAcknowledgedAt: string;
  startedAtMs: number;
  completedAtMs?: number;
};

export function localOnboardingStateKey(configPath: string): string {
  return `onboarding.local.${sha256Hex(path.resolve(configPath))}`;
}

export function normalizeLocalOnboardingState(
  value: unknown,
  configPath: string,
): LocalOnboardingState | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.status !== "pending" && value.status !== "completed") ||
    typeof value.runId !== "string" ||
    !value.runId ||
    value.configPath !== path.resolve(configPath) ||
    typeof value.workspace !== "string" ||
    !value.workspace ||
    typeof value.securityAcknowledgedAt !== "string" ||
    !value.securityAcknowledgedAt.trim() ||
    typeof value.startedAtMs !== "number" ||
    !Number.isFinite(value.startedAtMs) ||
    (value.status === "completed" &&
      (typeof value.completedAtMs !== "number" || !Number.isFinite(value.completedAtMs)))
  ) {
    return undefined;
  }
  const coordinator =
    typeof value.teamCoordinatorId === "string"
      ? normalizeAgentIdStrict(value.teamCoordinatorId)
      : undefined;
  if (value.teamCoordinatorId !== undefined && !coordinator?.ok) {
    return undefined;
  }
  // SAFETY: Required receipt fields and completed timestamps were validated above;
  // the optional coordinator is normalized here while extension fields remain intact.
  return {
    ...value,
    ...(coordinator?.ok ? { teamCoordinatorId: coordinator.value } : {}),
  } as LocalOnboardingState;
}
