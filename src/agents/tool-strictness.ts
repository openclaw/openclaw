export type ToolStrictnessMode = "off" | "warn" | "strict";

export function resolveToolStrictnessMode(params: {
  mode?: ToolStrictnessMode | null | undefined;
  env?: NodeJS.ProcessEnv;
}): ToolStrictnessMode {
  const env = params.env ?? process.env;
  const envMode = (env.OPENCLAW_TOOL_STRICTNESS_MODE ?? "").trim().toLowerCase();
  if (envMode === "off" || envMode === "warn" || envMode === "strict") {
    return envMode;
  }
  if (params.mode === "strict") {
    return "strict";
  }
  if (params.mode === "warn") {
    return "warn";
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
