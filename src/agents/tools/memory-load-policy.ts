import fs from "node:fs/promises";
import path from "node:path";

export type MemoryLoadPolicyConfig = {
  version: string;
  entrypoint: string;
  topicAllowlist: string[];
  deepAllowlist: string[];
  hardDenies: string[];
  escalation: {
    minConfidence: number;
    missSignalThreshold: number;
  };
};

export type MemoryLoadRuntimeMode = {
  enforce: boolean;
  reportOnly: boolean;
};

export type MemoryLoadDecision = {
  allowedPaths: string[];
  deniedPaths: Array<{ path: string; reason: string }>;
  escalated: boolean;
  escalationReason?: string;
  violation?: string;
  mode: MemoryLoadRuntimeMode;
  policyVersion: string;
};

export interface MemoryPolicyResult {
  disabled?: boolean;
  error?: string;
  results?: unknown[];
  policyVersion?: string;
}

export type MemoryTelemetryRecord = {
  ts: string;
  sessionKey?: string;
  taskId?: string;
  policyVersion: string;
  queryClass: string;
  entrypointLoaded: boolean;
  filesConsidered: number;
  topicFilesLoaded: string[];
  deepFilesLoaded: string[];
  deniedPaths: string[];
  escalated: boolean;
  escalationReason?: string;
  recallConfidence: number;
  missSignals: number;
  promptTokensEst?: number;
  policyViolation: boolean;
  policyViolationCode?: string;
  outcome: "PASS" | "BLOCK";
};

type PolicyPointer = {
  activePolicyPath?: string;
  version?: string;
  enforce?: boolean;
  reportOnly?: boolean;
};

const DEFAULT_POLICY: MemoryLoadPolicyConfig = {
  version: "v1.1",
  entrypoint: "MEMORY.md",
  topicAllowlist: ["memory/topics/*.md", "memory/*.md", "MEMORY.md"],
  deepAllowlist: ["memory/mission_log.md", "memory/runbook.md", "memory/**/*.md"],
  hardDenies: ["**/.env*", "**/secrets/**"],
  escalation: {
    minConfidence: 0.6,
    missSignalThreshold: 1,
  },
};

function toPosix(relPath: string): string {
  return relPath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relPath: string, patterns: string[]): boolean {
  const normalized = toPosix(relPath);
  return patterns.some((p) => wildcardToRegExp(toPosix(p)).test(normalized));
}

function classifyQuery(query: string): string {
  const q = query.toLowerCase();
  if (q.includes("govern") || q.includes("policy")) {
    return "governance";
  }
  if (q.includes("revenue") || q.includes("monet")) {
    return "monetization";
  }
  if (q.includes("pipeline") || q.includes("release")) {
    return "pipelines";
  }
  if (q.includes("reliab") || q.includes("incident")) {
    return "reliability";
  }
  return "general";
}

function isEntrypoint(relPath: string, entrypoint: string): boolean {
  const p = toPosix(relPath).toLowerCase();
  const e = toPosix(entrypoint).toLowerCase();
  return p === e || p === `memory/${e}`;
}

function isDeepPath(relPath: string): boolean {
  const p = toPosix(relPath).toLowerCase();
  return p.includes("mission_log") || p.includes("runbook") || p.startsWith("memory/");
}

function shouldEscalate(
  confidence: number,
  missSignals: number,
  policy: MemoryLoadPolicyConfig,
): { escalated: boolean; reason?: string } {
  if (confidence < policy.escalation.minConfidence) {
    return { escalated: true, reason: "low_confidence" };
  }
  if (missSignals >= policy.escalation.missSignalThreshold) {
    return { escalated: true, reason: "miss_signal_threshold" };
  }
  return { escalated: false };
}

export function enforceMemoryLoadPolicy(params: {
  query: string;
  candidatePaths: string[];
  confidence?: number;
  missSignals?: number;
  policy: MemoryLoadPolicyConfig;
  mode: MemoryLoadRuntimeMode;
}): MemoryLoadDecision {
  const confidence = params.confidence ?? 1;
  const missSignals = params.missSignals ?? 0;
  const { escalated, reason } = shouldEscalate(confidence, missSignals, params.policy);

  const allowedPaths: string[] = [];
  const deniedPaths: Array<{ path: string; reason: string }> = [];

  for (const raw of params.candidatePaths) {
    const relPath = toPosix(raw);
    if (matchesAny(relPath, params.policy.hardDenies)) {
      deniedPaths.push({ path: relPath, reason: "hard_deny" });
      continue;
    }
    if (isEntrypoint(relPath, params.policy.entrypoint)) {
      allowedPaths.push(relPath);
      continue;
    }
    if (matchesAny(relPath, params.policy.topicAllowlist)) {
      allowedPaths.push(relPath);
      continue;
    }
    if (escalated && matchesAny(relPath, params.policy.deepAllowlist)) {
      allowedPaths.push(relPath);
      continue;
    }
    deniedPaths.push({ path: relPath, reason: "out_of_scope" });
  }

  const hasEntrypoint = allowedPaths.some((p) => isEntrypoint(p, params.policy.entrypoint));
  if (!hasEntrypoint) {
    allowedPaths.unshift(params.policy.entrypoint);
  }

  return {
    allowedPaths,
    deniedPaths,
    escalated,
    escalationReason: reason,
    violation: undefined,
    mode: params.mode,
    policyVersion: params.policy.version,
  };
}

export async function resolveMemoryLoadPolicy(params?: {
  cwd?: string;
}): Promise<{ policy: MemoryLoadPolicyConfig; mode: MemoryLoadRuntimeMode; pointerPath: string }> {
  const cwd = params?.cwd ?? process.cwd();
  const pointerPath = process.env.OPENCLAW_MEMORY_POLICY_POINTER_PATH
    ? path.resolve(process.env.OPENCLAW_MEMORY_POLICY_POINTER_PATH)
    : path.resolve(cwd, "governance", "memory_load_policy_active.json");

  const fallbackPolicyPath = process.env.OPENCLAW_MEMORY_POLICY_PATH
    ? path.resolve(process.env.OPENCLAW_MEMORY_POLICY_PATH)
    : path.resolve(cwd, "governance", "memory_load_policy_v1_1.json");

  const defaultMode: MemoryLoadRuntimeMode = {
    enforce: process.env.OPENCLAW_MEMORY_POLICY_ENFORCE === "true",
    reportOnly: process.env.OPENCLAW_MEMORY_POLICY_REPORT_ONLY !== "false",
  };

  try {
    const raw = await fs.readFile(pointerPath, "utf8");
    const pointer = JSON.parse(raw) as PolicyPointer;
    const policyPath = pointer.activePolicyPath
      ? path.resolve(cwd, pointer.activePolicyPath)
      : fallbackPolicyPath;
    const policyRaw = await fs.readFile(policyPath, "utf8");
    const policy = {
      ...DEFAULT_POLICY,
      ...(JSON.parse(policyRaw) as Partial<MemoryLoadPolicyConfig>),
      version: pointer.version ?? DEFAULT_POLICY.version,
    };
    return {
      policy,
      mode: {
        enforce: pointer.enforce ?? defaultMode.enforce,
        reportOnly: pointer.reportOnly ?? defaultMode.reportOnly,
      },
      pointerPath,
    };
  } catch {
    // fail-closed mode if policy missing/invalid: block deep reads, allow entrypoint only.
    return {
      policy: {
        ...DEFAULT_POLICY,
        topicAllowlist: [DEFAULT_POLICY.entrypoint],
        deepAllowlist: [],
      },
      mode: {
        enforce: true,
        reportOnly: false,
      },
      pointerPath,
    };
  }
}

export async function appendMemoryLoadTelemetry(record: MemoryTelemetryRecord, cwd?: string) {
  const base = cwd ?? process.cwd();
  const target = path.resolve(base, "logs", "memory_load_telemetry.jsonl");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify(record)}\n`, "utf8");
  return target;
}

export function buildTelemetryRecord(params: {
  sessionKey?: string;
  taskId?: string;
  policyVersion: string;
  query: string;
  candidatePaths: string[];
  decision: MemoryLoadDecision;
  confidence?: number;
  missSignals?: number;
  promptTokensEst?: number;
  violationCode?: string;
}): MemoryTelemetryRecord {
  const entrypointLoaded = params.decision.allowedPaths.some((p) =>
    isEntrypoint(p, DEFAULT_POLICY.entrypoint),
  );
  const deepFilesLoaded = params.decision.allowedPaths.filter((p) => isDeepPath(p));
  const topicFilesLoaded = params.decision.allowedPaths.filter((p) => !deepFilesLoaded.includes(p));
  return {
    ts: new Date().toISOString(),
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    policyVersion: params.policyVersion,
    queryClass: classifyQuery(params.query),
    entrypointLoaded,
    filesConsidered: params.candidatePaths.length,
    topicFilesLoaded,
    deepFilesLoaded,
    deniedPaths: params.decision.deniedPaths.map((d) => d.path),
    escalated: params.decision.escalated,
    escalationReason: params.decision.escalationReason,
    recallConfidence: params.confidence ?? 1,
    missSignals: params.missSignals ?? 0,
    promptTokensEst: params.promptTokensEst,
    policyViolation: Boolean(params.violationCode),
    policyViolationCode: params.violationCode,
    outcome: params.violationCode ? "BLOCK" : "PASS",
  };
}
