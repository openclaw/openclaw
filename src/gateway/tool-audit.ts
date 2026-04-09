import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";

const GATEWAY_TOOL_AUDIT_LOG_FILENAME = "gateway-tool-audit.jsonl";

export type GatewayToolAuditSurface = "tools-invoke" | "openresponses";

export type GatewayToolAuditContext = {
  surface: GatewayToolAuditSurface;
  sessionKey?: string;
  messageChannel?: string;
  model?: string | null;
};

export type GatewayToolAuditRecord = {
  ts: string;
  source: "gateway";
  event: "tool.call";
  surface: GatewayToolAuditSurface;
  tool: string;
  args: unknown;
  session: string | null;
  channel: string | null;
  model: string | null;
  runId: string | null;
  toolCallId: string | null;
};

export function resolveGatewayToolAuditLogPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir?: () => string,
): string {
  return path.join(resolveStateDir(env, homedir), "logs", GATEWAY_TOOL_AUDIT_LOG_FILENAME);
}

export function sanitizeGatewayToolAuditArgs(args: unknown): unknown {
  try {
    const raw = JSON.stringify(args ?? null);
    const redacted = redactSensitiveText(raw, { mode: "tools" });
    return JSON.parse(redacted) as unknown;
  } catch {
    return redactSensitiveText(String(args), { mode: "tools" });
  }
}

export function createGatewayToolAuditRecord(params: {
  tool: string;
  args: unknown;
  ctx: GatewayToolAuditContext;
  runId?: string;
  toolCallId?: string;
  now?: string;
}): GatewayToolAuditRecord {
  return {
    ts: params.now ?? new Date().toISOString(),
    source: "gateway",
    event: "tool.call",
    surface: params.ctx.surface,
    tool: params.tool,
    args: sanitizeGatewayToolAuditArgs(params.args),
    session: params.ctx.sessionKey ?? null,
    channel: params.ctx.messageChannel ?? null,
    model: params.ctx.model ?? null,
    runId: params.runId ?? null,
    toolCallId: params.toolCallId ?? null,
  };
}

export async function appendGatewayToolAuditRecord(params: {
  record: GatewayToolAuditRecord;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<void> {
  const auditPath = resolveGatewayToolAuditLogPath(params.env, params.homedir);
  await fs.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(auditPath, `${JSON.stringify(params.record)}\n`, { encoding: "utf8", mode: 0o600 });
}
