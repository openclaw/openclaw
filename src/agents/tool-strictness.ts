export type ToolStrictnessMode = "off" | "warn" | "strict";

export function resolveToolStrictnessMode(params: {
  mode?: ToolStrictnessMode | null | undefined;
  env?: NodeJS.ProcessEnv;
}): ToolStrictnessMode {
  if (params.mode === "strict") {
    return "strict";
  }
  if (params.mode === "warn") {
    return "warn";
  }
  if (params.mode === "off") {
    return "off";
  }
  const env = params.env ?? process.env;
  const envMode = (env.OPENCLAW_TOOL_STRICTNESS_MODE ?? "").trim().toLowerCase();
  if (envMode === "off" || envMode === "warn" || envMode === "strict") {
    return envMode;
  }
  return "off";
}

export function isStrictToolMode(mode: ToolStrictnessMode): boolean {
  return mode === "strict";
}

export function shouldAllowToolArgumentRepair(mode: ToolStrictnessMode): boolean {
  return !isStrictToolMode(mode);
}

export function shouldAllowToolArgumentAlias(mode: ToolStrictnessMode): boolean {
  return !isStrictToolMode(mode);
}

export function shouldAllowToolNameNormalization(mode: ToolStrictnessMode): boolean {
  return !isStrictToolMode(mode);
}

export function shouldAllowTranscriptToolCallNormalization(mode: ToolStrictnessMode): boolean {
  return !isStrictToolMode(mode);
}

export function isWarnToolMode(mode: ToolStrictnessMode): boolean {
  return mode === "warn";
}

export type ToolStrictnessRepairEvent =
  | {
      kind: "argumentKeyAlias";
      tool: string;
      from: string;
      to: string;
      mode: ToolStrictnessMode;
    }
  | {
      kind: "argumentShapeRepair";
      fromType: string;
      toType: "object";
      mode: ToolStrictnessMode;
      detail: "json-parse" | "fallback-empty-object";
    }
  | {
      kind: "toolNameNormalization";
      from: string;
      to: string;
      mode: ToolStrictnessMode;
      detail: "exact-canonical" | "structured-canonical";
    };

export function createToolArgumentAliasEvent(params: {
  tool: string;
  from: string;
  to: string;
  mode: ToolStrictnessMode;
}): ToolStrictnessRepairEvent {
  return {
    kind: "argumentKeyAlias",
    tool: params.tool,
    from: params.from,
    to: params.to,
    mode: params.mode,
  };
}

export function createToolArgumentShapeRepairEvent(params: {
  fromType: string;
  mode: ToolStrictnessMode;
  detail: "json-parse" | "fallback-empty-object";
}): ToolStrictnessRepairEvent {
  return {
    kind: "argumentShapeRepair",
    fromType: params.fromType,
    toType: "object",
    mode: params.mode,
    detail: params.detail,
  };
}

export function createToolNameNormalizationEvent(params: {
  from: string;
  to: string;
  mode: ToolStrictnessMode;
  detail: "exact-canonical" | "structured-canonical";
}): ToolStrictnessRepairEvent {
  return {
    kind: "toolNameNormalization",
    from: params.from,
    to: params.to,
    mode: params.mode,
    detail: params.detail,
  };
}

export function emitToolStrictnessRepairEvent(params: {
  event: ToolStrictnessRepairEvent;
  onRepairEvent?: ((event: ToolStrictnessRepairEvent) => void) | undefined;
  logger?: ((message: string) => void) | undefined;
}): ToolStrictnessRepairEvent {
  const message = `tool strictness repair: ${JSON.stringify(params.event)}`;
  params.onRepairEvent?.(params.event);
  params.logger?.(message);
  return params.event;
}

export type ToolStrictnessWarnSurfaceReason =
  | "repair"
  | "compatibilityObservation"
  | "replayDiagnostic";

export type ToolStrictnessStrictFailureReason = "repair" | "replayDiagnostic";

export type ToolStrictnessCompatibilityLevel =
  | "clean"
  | "warn-surfaced"
  | "strict-failure-candidate";

export type ToolStrictnessSummary = {
  compatibilityObservationCount: number;
  toolUseDiagnosticCount: number;
  repairCount: number;
  hadAnyRepair: boolean;
  hadCompatibilityObservation: boolean;
  hadReplayDiagnostic: boolean;
  warnSurfaceUsed: boolean;
  strictFailureCandidate: boolean;
  compatibilityLevel: ToolStrictnessCompatibilityLevel;
  warnSurfaceReasons: ToolStrictnessWarnSurfaceReason[];
  strictFailureReasons: ToolStrictnessStrictFailureReason[];
  compatibilityObservationKindCounts: {
    toolCallBlockTypeCompatibility: number;
  };
  toolUseDiagnosticKindCounts: {
    toolUseReplayDiagnostic: number;
  };
  repairKindCounts: {
    argumentKeyAlias: number;
    argumentShapeRepair: number;
    toolNameNormalization: number;
  };
};

export function createEmptyToolStrictnessSummary(): ToolStrictnessSummary {
  return {
    compatibilityObservationCount: 0,
    toolUseDiagnosticCount: 0,
    repairCount: 0,
    hadAnyRepair: false,
    hadCompatibilityObservation: false,
    hadReplayDiagnostic: false,
    warnSurfaceUsed: false,
    strictFailureCandidate: false,
    compatibilityLevel: "clean",
    warnSurfaceReasons: [],
    strictFailureReasons: [],
    compatibilityObservationKindCounts: {
      toolCallBlockTypeCompatibility: 0,
    },
    toolUseDiagnosticKindCounts: {
      toolUseReplayDiagnostic: 0,
    },
    repairKindCounts: {
      argumentKeyAlias: 0,
      argumentShapeRepair: 0,
      toolNameNormalization: 0,
    },
  };
}

export function recordToolStrictnessCompatibilityObservation(
  summary: ToolStrictnessSummary,
  event: { kind: "toolCallBlockTypeCompatibility" },
): void {
  summary.compatibilityObservationCount += 1;
  summary.hadCompatibilityObservation = true;
  summary.warnSurfaceUsed = true;
  if (summary.compatibilityLevel === "clean") {
    summary.compatibilityLevel = "warn-surfaced";
  }
  if (!summary.warnSurfaceReasons.includes("compatibilityObservation")) {
    summary.warnSurfaceReasons.push("compatibilityObservation");
  }
  summary.compatibilityObservationKindCounts[event.kind] += 1;
}

export function recordToolUseDiagnostic(
  summary: ToolStrictnessSummary,
  event: { kind: "toolUseReplayDiagnostic" },
): void {
  summary.toolUseDiagnosticCount += 1;
  summary.hadReplayDiagnostic = true;
  summary.warnSurfaceUsed = true;
  summary.strictFailureCandidate = true;
  summary.compatibilityLevel = "strict-failure-candidate";
  if (!summary.warnSurfaceReasons.includes("replayDiagnostic")) {
    summary.warnSurfaceReasons.push("replayDiagnostic");
  }
  if (!summary.strictFailureReasons.includes("replayDiagnostic")) {
    summary.strictFailureReasons.push("replayDiagnostic");
  }
  summary.toolUseDiagnosticKindCounts[event.kind] += 1;
}

export function recordToolStrictnessRepair(
  summary: ToolStrictnessSummary,
  event: ToolStrictnessRepairEvent,
): void {
  summary.repairCount += 1;
  summary.hadAnyRepair = true;
  summary.warnSurfaceUsed = true;
  summary.strictFailureCandidate = true;
  summary.compatibilityLevel = "strict-failure-candidate";
  if (!summary.warnSurfaceReasons.includes("repair")) {
    summary.warnSurfaceReasons.push("repair");
  }
  if (!summary.strictFailureReasons.includes("repair")) {
    summary.strictFailureReasons.push("repair");
  }
  summary.repairKindCounts[event.kind] += 1;
}
