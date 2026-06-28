// Defines plugin approval request/resolution payloads and actions.
import type { ExecApprovalDecision } from "./exec-approvals.js";

// Plugin approval types and renderers mirror exec approval decisions while
// keeping plugin-facing request text and action metadata separate.
/** Button/action metadata shown with a plugin approval request. */
export type PluginApprovalActionView = {
  kind?: "command" | "decision";
  label: string;
  command: string;
  decision?: ExecApprovalDecision;
  style?: "primary" | "secondary" | "success" | "danger";
};

export type PluginApprovalExternalResolutionDecision = Extract<
  ExecApprovalDecision,
  "allow-once" | "allow-always"
>;

export type PluginApprovalExternalResolutionTemplate = {
  label: string;
  commandTemplate: string;
  decisions?: readonly PluginApprovalExternalResolutionDecision[];
};

export type PluginApprovalExternalResolutionCommand = {
  decision: PluginApprovalExternalResolutionDecision;
  label: string;
  description: string;
  command: string;
};

export type PluginApprovalExternalResolution = {
  label: string;
  commands: readonly PluginApprovalExternalResolutionCommand[];
};

/** Request payload supplied by plugin approval callers. */
export type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  actions?: readonly PluginApprovalActionView[] | null;
  externalResolution?: PluginApprovalExternalResolution | null;
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

/** Timed plugin approval request persisted while awaiting a decision. */
export type PluginApprovalRequest = {
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

/** Resolved plugin approval decision plus optional request snapshot. */
export type PluginApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: PluginApprovalRequestPayload;
};

export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
export const PLUGIN_APPROVAL_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_EXTERNAL_RESOLUTION_COMMAND_TEMPLATE_MAX_LENGTH = 256;
export const DEFAULT_PLUGIN_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
const DEFAULT_PLUGIN_APPROVAL_EXTERNAL_RESOLUTION_DECISIONS = [
  "allow-once",
] as const satisfies readonly PluginApprovalExternalResolutionDecision[];

function isExternalResolutionDecision(
  decision: unknown,
): decision is PluginApprovalExternalResolutionDecision {
  return decision === "allow-once" || decision === "allow-always";
}

function externalResolutionDecisionLabel(
  decision: PluginApprovalExternalResolutionDecision,
): string {
  return decision === "allow-always" ? "Verify and trust for session" : "Verify once";
}

function approvalDecisionPromptLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "Allow once";
  }
  if (decision === "allow-always") {
    return "Allow always";
  }
  return "Deny";
}

function approvalDecisionPromptDescription(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "Approve this blocked action only";
  }
  if (decision === "allow-always") {
    return "Trust approvals for this session";
  }
  return "Reject this blocked action";
}

function resolveExternalResolutionDecisions(
  decisions?: readonly PluginApprovalExternalResolutionDecision[],
): readonly PluginApprovalExternalResolutionDecision[] {
  const explicit: PluginApprovalExternalResolutionDecision[] = [];
  if (Array.isArray(decisions)) {
    for (const decision of decisions) {
      if (isExternalResolutionDecision(decision) && !explicit.includes(decision)) {
        explicit.push(decision);
      }
    }
  }
  return explicit.length > 0 ? explicit : DEFAULT_PLUGIN_APPROVAL_EXTERNAL_RESOLUTION_DECISIONS;
}

function normalizeTemplateString(params: {
  field: string;
  maxLength: number;
  value: string;
}): string {
  const trimmed = params.value.trim();
  if (!trimmed) {
    throw new Error(`${params.field} is required`);
  }
  if (trimmed.length > params.maxLength) {
    throw new Error(`${params.field} must be ${params.maxLength} characters or less`);
  }
  return trimmed;
}

/** Clamp a plugin approval timeout to the supported runtime bounds. */
export function resolvePluginApprovalTimeoutMs(value: unknown): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  return Math.min(MAX_PLUGIN_APPROVAL_TIMEOUT_MS, Math.max(1, Math.floor(candidate)));
}

/** Format an approval decision for user-facing messages. */
export function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

/** Resolve explicit plugin approval decisions or fall back to defaults. */
export function resolvePluginApprovalRequestAllowedDecisions(params?: {
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const explicit: ExecApprovalDecision[] = [];
  if (Array.isArray(params?.allowedDecisions)) {
    for (const decision of params.allowedDecisions) {
      if (
        (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
        !explicit.includes(decision)
      ) {
        explicit.push(decision);
      }
    }
  }
  return explicit.length > 0 ? explicit : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
}

export function buildPluginApprovalExternalResolution(params: {
  approvalId: string;
  externalResolution?: PluginApprovalExternalResolutionTemplate | null;
}): PluginApprovalExternalResolution | null {
  const externalResolution = params.externalResolution;
  if (!externalResolution) {
    return null;
  }
  const label = normalizeTemplateString({
    field: "externalResolution.label",
    maxLength: PLUGIN_APPROVAL_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH,
    value: externalResolution.label,
  });
  const commandTemplate = normalizeTemplateString({
    field: "externalResolution.commandTemplate",
    maxLength: PLUGIN_APPROVAL_EXTERNAL_RESOLUTION_COMMAND_TEMPLATE_MAX_LENGTH,
    value: externalResolution.commandTemplate,
  });
  if (!commandTemplate.includes("{id}") || !commandTemplate.includes("{decision}")) {
    throw new Error("externalResolution.commandTemplate must include {id} and {decision}");
  }
  const decisions = resolveExternalResolutionDecisions(externalResolution.decisions);
  return {
    label,
    commands: decisions.map((decision) => ({
      decision,
      label: externalResolutionDecisionLabel(decision),
      description: approvalDecisionPromptDescription(decision),
      command: commandTemplate
        .replaceAll("{id}", params.approvalId)
        .replaceAll("{decision}", decision),
    })),
  };
}

function appendApprovalCommandLines(params: {
  lines: string[];
  request: PluginApprovalRequest;
}): void {
  const { lines, request } = params;
  const externalResolution = request.request.externalResolution ?? null;
  if (!externalResolution) {
    lines.push(
      `Reply with: /approve ${request.id} ${resolvePluginApprovalRequestAllowedDecisions(
        request.request,
      ).join("|")}`,
    );
    return;
  }

  const externalDecisions = new Set<ExecApprovalDecision>(
    externalResolution.commands.map((command) => command.decision),
  );
  const approvalCommands = resolvePluginApprovalRequestAllowedDecisions(request.request)
    .filter((decision) => !externalDecisions.has(decision))
    .map((decision) => ({
      label: approvalDecisionPromptLabel(decision),
      description: approvalDecisionPromptDescription(decision),
      command: `/approve ${request.id} ${decision}`,
    }));

  lines.push(`External verification: ${externalResolution.label}`);
  lines.push("Reply with one of:");
  for (const command of externalResolution.commands) {
    lines.push(`${command.label}: ${command.description}`);
    lines.push(command.command);
  }
  for (const command of approvalCommands) {
    lines.push(`${command.label}: ${command.description}`);
    lines.push(command.command);
  }
}

/** Build the pending plugin approval message. */
export function buildPluginApprovalRequestMessage(
  request: PluginApprovalRequest,
  nowMsValue: number,
): string {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  lines.push(`${icon} Plugin approval required`);
  lines.push(`Title: ${request.request.title}`);
  lines.push(`Description: ${request.request.description}`);
  if (request.request.toolName) {
    lines.push(`Tool: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`Plugin: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  lines.push(`ID: ${request.id}`);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMsValue) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  appendApprovalCommandLines({ lines, request });
  return lines.join("\n");
}

/** Build the plugin approval resolution message. */
export function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string {
  const base = `✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

/** Build the plugin approval expiration message. */
export function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string {
  return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
