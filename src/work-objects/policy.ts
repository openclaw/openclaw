import type { WorkObject, WorkObjectPolicy, WorkObjectWorkerRole } from "./types.js";

export const DEFAULT_CODING_WORKER_POLICY_ID = "codex-clawd-gemini";

export function createDefaultCodingWorkerPolicy(params?: {
  adaMedicalDeviceRegulatoryRequired?: boolean;
}): WorkObjectPolicy {
  const policy: WorkObjectPolicy = {
    id: DEFAULT_CODING_WORKER_POLICY_ID,
    label: "Codex implementer + Clawd reviewer + Gemini verifier",
    successRequires: "all_required_pass",
    requirements: [
      {
        role: "implementer",
        engine: "codex",
        required: true,
        modelStrategy: "default",
        label: "Codex implementation pass",
      },
      {
        role: "reviewer",
        engine: "claude-code",
        required: true,
        model: "opus47-cli",
        modelStrategy: "explicit",
        label: "Clawd / Claude Code Opus 4.7 review pass",
      },
      {
        role: "verifier",
        engine: "gemini-cli",
        required: true,
        modelStrategy: "strongest_available",
        label: "Gemini CLI strongest-available verification pass",
      },
    ],
  };
  if (params?.adaMedicalDeviceRegulatoryRequired) {
    policy.id = `${DEFAULT_CODING_WORKER_POLICY_ID}-ada-regulatory`;
    policy.label = `${policy.label} + Ada regulatory package`;
    policy.requirements.push({
      role: "judge",
      engine: "external",
      required: true,
      label: "Ada IEC 62304 regulatory package",
    });
  }
  return policy;
}

const ADA_MEDICAL_DEVICE_PATH_PATTERNS = [
  /(^|\/)engineering\/ada(\/|$)/i,
  /(^|\/)engineering\/medical-engine(\/|$)/i,
  /(^|\/)engineering\/assessment-fe(\/|$)/i,
  /(^|\/)engineering\/assess-2(\/|$)/i,
  /(^|\/)medical\//i,
];

export function requiresAdaMedicalDeviceRegulatory(params: {
  workspaceDir?: string;
  changedFiles?: string[];
  tags?: string[];
}): boolean {
  const tags = params.tags ?? [];
  if (tags.some((tag) => /ada[-_ ]?medical[-_ ]?device|iec[-_ ]?62304/i.test(tag))) {
    return true;
  }
  const candidates = [params.workspaceDir, ...(params.changedFiles ?? [])].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return candidates.some((candidate) =>
    ADA_MEDICAL_DEVICE_PATH_PATTERNS.some((pattern) => pattern.test(candidate)),
  );
}

function latestRunForRole(workObject: WorkObject, role: WorkObjectWorkerRole) {
  return workObject.workerRuns
    .filter((run) => run.role === role)
    .toSorted(
      (a, b) => (b.endedAtMs ?? b.startedAtMs ?? 0) - (a.endedAtMs ?? a.startedAtMs ?? 0),
    )[0];
}

export function evaluateWorkObjectPolicy(workObject: WorkObject): {
  satisfied: boolean;
  missingRoles: WorkObjectWorkerRole[];
  failedRoles: WorkObjectWorkerRole[];
  warningRoles: WorkObjectWorkerRole[];
} {
  const policy = workObject.workerPolicy;
  if (!policy) {
    return { satisfied: true, missingRoles: [], failedRoles: [], warningRoles: [] };
  }

  const missingRoles: WorkObjectWorkerRole[] = [];
  const failedRoles: WorkObjectWorkerRole[] = [];
  const warningRoles: WorkObjectWorkerRole[] = [];

  for (const requirement of policy.requirements) {
    if (!requirement.required) {
      continue;
    }
    const run = latestRunForRole(workObject, requirement.role);
    if (!run) {
      missingRoles.push(requirement.role);
      continue;
    }
    if (run.verdict?.status === "fail" || run.status === "failed" || run.status === "timed_out") {
      failedRoles.push(requirement.role);
      continue;
    }
    if (run.verdict?.status === "warn") {
      warningRoles.push(requirement.role);
    }
    if (run.status !== "succeeded" && run.verdict?.status !== "pass") {
      missingRoles.push(requirement.role);
    }
  }

  return {
    satisfied: missingRoles.length === 0 && failedRoles.length === 0,
    missingRoles,
    failedRoles,
    warningRoles,
  };
}
