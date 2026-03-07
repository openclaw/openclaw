import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  createKnowledgeTransferPolicyResolver,
  type KnowledgeTransferMode,
} from "../../infra/knowledge-transfer-policy.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionReference,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

type TransferPayloadItem = {
  text: string;
  sourcePath: string;
  fingerprint: string;
};

type ApprovedTransferItem = TransferPayloadItem & {
  exportMode: KnowledgeTransferMode;
  importMode: KnowledgeTransferMode;
};

type ApprovalKind = "export" | "import";

type ApprovalResult =
  | {
      ok: true;
      approved: boolean;
      approvalId?: string;
      decision?: string;
    }
  | {
      ok: false;
      error: string;
    };

type TransferImportResult = {
  imported: number;
  skippedDuplicate: number;
  filePath?: string;
  importedFingerprints: string[];
};

const SessionsTransferKnowledgeToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  question: Type.Optional(Type.String({ minLength: 1 })),
});

const APPROVAL_STATUS_ACCEPTED = "accepted";
const APPROVAL_DECISION_ALLOW = "allow";
const TRANSFER_FINGERPRINT_MARKER = "openclaw-transfer-fingerprint";
const MAX_TRANSFER_ITEMS = 500;
const MAX_APPROVAL_SUMMARY_ITEMS = 50;

function normalizeKnowledgeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function normalizeSourcePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[./]+/, "");
}

function computeTransferFingerprint(params: { text: string; sourcePath: string }): string {
  const normalizedText = normalizeKnowledgeText(params.text);
  return crypto
    .createHash("sha256")
    .update(`${params.sourcePath}\n${normalizedText}`)
    .digest("hex");
}

function fileSafeSegment(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
  return safe.replace(/^-|-$/g, "") || "agent";
}

function isMarkdownMemoryFile(relPath: string): boolean {
  const normalized = normalizeSourcePath(relPath).toLowerCase();
  if (normalized === "memory.md") {
    return true;
  }
  return normalized.startsWith("memory/") && normalized.endsWith(".md");
}

async function listMemoryFiles(
  workspaceDir: string,
): Promise<Array<{ absPath: string; sourcePath: string }>> {
  const files: Array<{ absPath: string; sourcePath: string }> = [];

  const memoryRootFile = path.join(workspaceDir, "MEMORY.md");
  try {
    const stat = await fs.stat(memoryRootFile);
    if (stat.isFile()) {
      files.push({
        absPath: memoryRootFile,
        sourcePath: "MEMORY.md",
      });
    }
  } catch {
    // Ignore missing root memory file.
  }

  const memoryDir = path.join(workspaceDir, "memory");
  async function walk(dir: string, relDir: string): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      files.push({
        absPath,
        sourcePath: normalizeSourcePath(`memory/${relPath}`),
      });
    }
  }

  await walk(memoryDir, "");
  return files;
}

function extractKnowledgeItemsFromMarkdown(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("```")) {
      continue;
    }
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) {
      continue;
    }
    items.push(trimmed);
  }
  return items;
}

async function collectTransferPayloadFromWorkspace(
  workspaceDir: string,
): Promise<TransferPayloadItem[]> {
  const files = await listMemoryFiles(workspaceDir);
  const items: TransferPayloadItem[] = [];

  for (const file of files) {
    if (!isMarkdownMemoryFile(file.sourcePath)) {
      continue;
    }
    let text = "";
    try {
      text = await fs.readFile(file.absPath, "utf-8");
    } catch {
      continue;
    }

    const extracted = extractKnowledgeItemsFromMarkdown(text);
    for (const snippet of extracted) {
      const normalizedText = normalizeKnowledgeText(snippet);
      if (!normalizedText) {
        continue;
      }
      const fingerprint = computeTransferFingerprint({
        text: normalizedText,
        sourcePath: file.sourcePath,
      });
      items.push({
        text: normalizedText,
        sourcePath: file.sourcePath,
        fingerprint,
      });
      if (items.length >= MAX_TRANSFER_ITEMS) {
        return items;
      }
    }
  }

  return items;
}

async function collectExistingTransferFingerprints(transferDir: string): Promise<Set<string>> {
  const existing = new Set<string>();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(transferDir);
  } catch {
    return existing;
  }

  const marker = new RegExp(`${TRANSFER_FINGERPRINT_MARKER}:\\s*([a-f0-9]{64})`, "gi");
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) {
      continue;
    }
    const absPath = path.join(transferDir, entry);
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) {
        continue;
      }
      const text = await fs.readFile(absPath, "utf-8");
      for (const match of text.matchAll(marker)) {
        const fingerprint = match[1]?.toLowerCase();
        if (fingerprint) {
          existing.add(fingerprint);
        }
      }
    } catch {
      // Ignore per-file read failures.
    }
  }

  return existing;
}

function buildTransferFileContent(params: {
  requesterAgentId: string;
  targetAgentId: string;
  targetSessionKey: string;
  exportApprovalId?: string;
  importApprovalId?: string;
  importedItems: ApprovedTransferItem[];
}): string {
  const lines: string[] = [
    "# Knowledge Transfer",
    "",
    `- Requester Agent: ${params.requesterAgentId}`,
    `- Target Agent: ${params.targetAgentId}`,
    `- Target Session: ${params.targetSessionKey}`,
    `- Transferred At: ${new Date().toISOString()}`,
  ];
  if (params.exportApprovalId) {
    lines.push(`- Export Approval ID: ${params.exportApprovalId}`);
  }
  if (params.importApprovalId) {
    lines.push(`- Import Approval ID: ${params.importApprovalId}`);
  }
  lines.push("", "## Imported Items", "");

  for (let i = 0; i < params.importedItems.length; i += 1) {
    const item = params.importedItems[i];
    lines.push(`### Item ${i + 1}`);
    lines.push(`<!-- ${TRANSFER_FINGERPRINT_MARKER}: ${item.fingerprint} -->`);
    lines.push(`Source: ${item.sourcePath}`);
    lines.push(`Modes: export=${item.exportMode}, import=${item.importMode}`);
    lines.push("");
    lines.push(item.text);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function importTransferredKnowledge(params: {
  cfg: ReturnType<typeof loadConfig>;
  requesterAgentId: string;
  targetAgentId: string;
  targetSessionKey: string;
  exportApprovalId?: string;
  importApprovalId?: string;
  items: ApprovedTransferItem[];
}): Promise<TransferImportResult> {
  const requesterWorkspace = resolveAgentWorkspaceDir(params.cfg, params.requesterAgentId);
  const transferDir = path.join(requesterWorkspace, "memory", "transfers");
  await fs.mkdir(transferDir, { recursive: true });

  const existingFingerprints = await collectExistingTransferFingerprints(transferDir);
  const importedItems: ApprovedTransferItem[] = [];
  let skippedDuplicate = 0;

  for (const item of params.items) {
    const normalizedFingerprint = item.fingerprint.toLowerCase();
    if (existingFingerprints.has(normalizedFingerprint)) {
      skippedDuplicate += 1;
      continue;
    }
    existingFingerprints.add(normalizedFingerprint);
    importedItems.push(item);
  }

  if (importedItems.length === 0) {
    return {
      imported: 0,
      skippedDuplicate,
      importedFingerprints: [],
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}-${fileSafeSegment(params.targetAgentId)}-to-${fileSafeSegment(
    params.requesterAgentId,
  )}.md`;
  const filePath = path.join(transferDir, fileName);
  const content = buildTransferFileContent({
    requesterAgentId: params.requesterAgentId,
    targetAgentId: params.targetAgentId,
    targetSessionKey: params.targetSessionKey,
    exportApprovalId: params.exportApprovalId,
    importApprovalId: params.importApprovalId,
    importedItems,
  });
  await fs.writeFile(filePath, content, "utf-8");

  return {
    imported: importedItems.length,
    skippedDuplicate,
    filePath,
    importedFingerprints: importedItems.map((item) => item.fingerprint),
  };
}

function buildApprovalSummary(items: ApprovedTransferItem[]): string[] {
  return items.slice(0, MAX_APPROVAL_SUMMARY_ITEMS).map((item, index) => {
    const preview = item.text.split("\n")[0]?.trim() ?? "";
    const capped = preview.length > 140 ? `${preview.slice(0, 137)}...` : preview;
    return `${index + 1}. [${item.sourcePath}] ${capped}`;
  });
}

async function requestKnowledgeTransferApproval(params: {
  approvalKind: ApprovalKind;
  requesterAgentId: string;
  targetAgentId: string;
  requesterSessionKey: string;
  targetSessionKey: string;
  requestedBySessionKey?: string;
  requestedByChannel?: GatewayMessageChannel;
  timeoutMs: number;
  items: ApprovedTransferItem[];
}): Promise<ApprovalResult> {
  const itemFingerprints = params.items.map((item) => item.fingerprint);
  const summary = buildApprovalSummary(params.items);

  let requestResponse:
    | {
        status?: string;
        id?: string;
      }
    | undefined;
  try {
    requestResponse = await callGateway<{
      status?: string;
      id?: string;
    }>({
      method: "knowledge.transfer.approval.request",
      params: {
        approvalKind: params.approvalKind,
        requesterAgentId: params.requesterAgentId,
        targetAgentId: params.targetAgentId,
        requesterSessionKey: params.requesterSessionKey,
        targetSessionKey: params.targetSessionKey,
        requestedBySessionKey: params.requestedBySessionKey,
        requestedByChannel: params.requestedByChannel,
        mode: "ask",
        itemCount: params.items.length,
        itemFingerprints,
        summary,
        timeoutMs: params.timeoutMs,
        twoPhase: true,
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const status = typeof requestResponse?.status === "string" ? requestResponse.status : "";
  const approvalId = typeof requestResponse?.id === "string" ? requestResponse.id.trim() : "";
  if (status !== APPROVAL_STATUS_ACCEPTED || !approvalId) {
    return {
      ok: false,
      error: `failed to create ${params.approvalKind} knowledge transfer approval request`,
    };
  }

  let waitResponse: { decision?: string | null } | undefined;
  try {
    waitResponse = await callGateway<{ decision?: string | null }>({
      method: "knowledge.transfer.approval.wait",
      params: { id: approvalId },
      timeoutMs: params.timeoutMs + 2000,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const decision =
    typeof waitResponse?.decision === "string"
      ? waitResponse.decision.trim().toLowerCase()
      : "timeout";
  return {
    ok: true,
    approved: decision === APPROVAL_DECISION_ALLOW,
    approvalId,
    decision,
  };
}

export function createSessionsTransferKnowledgeTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
}): AnyAgentTool {
  return {
    label: "Session Transfer Knowledge",
    name: "sessions_transfer_knowledge",
    description:
      "Transfer memory knowledge from another session using per-path export/import policy with optional owner approvals.",
    parameters: SessionsTransferKnowledgeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = readStringParam(params, "label")?.trim() || undefined;
      const labelAgentIdParam = readStringParam(params, "agentId")?.trim() || undefined;
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey or label (not both).",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_transfer_knowledge label lookup is limited to this agent",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };

        try {
          const resolved = await callGateway<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          const resolvedKey = typeof resolved?.key === "string" ? resolved.key.trim() : "";
          if (!resolvedKey) {
            throw new Error(`No session found with label: ${labelParam}`);
          }
          sessionKey = resolvedKey;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({
            runId: crypto.randomUUID(),
            status: restrictToSpawned ? "forbidden" : "error",
            error: restrictToSpawned
              ? "Session not visible from this sandboxed agent session."
              : message || `No session found with label: ${labelParam}`,
          });
        }
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey or label is required",
        });
      }

      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }

      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: visibleSession.displayKey,
        });
      }

      const resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: displayKey,
        });
      }

      const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
      const targetAgentId = resolveAgentIdFromSessionKey(resolvedKey);
      const policyResolver = await createKnowledgeTransferPolicyResolver({
        cfg,
        requesterAgentId,
        targetAgentId,
      });
      if (!policyResolver.defaults.enabled) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "forbidden",
          error:
            "Knowledge transfer is disabled. Set tools.agentToAgent.knowledgeTransfer.enabled=true to allow sessions_transfer_knowledge.",
          sessionKey: displayKey,
        });
      }

      const targetWorkspace = resolveAgentWorkspaceDir(cfg, targetAgentId);
      const payloadItems = await collectTransferPayloadFromWorkspace(targetWorkspace);
      if (payloadItems.length === 0) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "No transferable memory content found in target agent memory files.",
          sessionKey: displayKey,
        });
      }

      let blockedExport = 0;
      let blockedImport = 0;
      const allowedByPolicy: ApprovedTransferItem[] = [];
      for (const item of payloadItems) {
        const exportDecision = policyResolver.resolve("export", item.sourcePath);
        if (!exportDecision.allowed || !exportDecision.mode) {
          blockedExport += 1;
          continue;
        }
        const importDecision = policyResolver.resolve("import", item.sourcePath);
        if (!importDecision.allowed || !importDecision.mode) {
          blockedImport += 1;
          continue;
        }
        allowedByPolicy.push({
          ...item,
          exportMode: exportDecision.mode,
          importMode: importDecision.mode,
        });
      }

      const timeoutSecondsRaw =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 0;
      const approvalTimeoutMs =
        timeoutSecondsRaw > 0
          ? timeoutSecondsRaw * 1000
          : Math.max(1000, Math.floor(policyResolver.defaults.approvalTimeoutSeconds * 1000));

      const exportAuto = allowedByPolicy.filter((item) => item.exportMode === "auto");
      const exportAsk = allowedByPolicy.filter((item) => item.exportMode === "ask");

      let exportApprovedAsk: ApprovedTransferItem[] = [];
      let exportApprovalId: string | undefined;
      let exportApprovalDecision: string | undefined;
      if (exportAsk.length > 0) {
        const approval = await requestKnowledgeTransferApproval({
          approvalKind: "export",
          requesterAgentId,
          targetAgentId,
          requesterSessionKey: effectiveRequesterKey,
          targetSessionKey: resolvedKey,
          requestedBySessionKey: opts?.agentSessionKey,
          requestedByChannel: opts?.agentChannel,
          timeoutMs: approvalTimeoutMs,
          items: exportAsk,
        });
        if (!approval.ok) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: approval.error,
            sessionKey: displayKey,
          });
        }
        exportApprovalId = approval.approvalId;
        exportApprovalDecision = approval.decision;
        if (approval.approved) {
          exportApprovedAsk = exportAsk;
        }
      }

      const postExport = [...exportAuto, ...exportApprovedAsk];
      const importAuto = postExport.filter((item) => item.importMode === "auto");
      const importAsk = postExport.filter((item) => item.importMode === "ask");

      let importApprovedAsk: ApprovedTransferItem[] = [];
      let importApprovalId: string | undefined;
      let importApprovalDecision: string | undefined;
      if (importAsk.length > 0) {
        const approval = await requestKnowledgeTransferApproval({
          approvalKind: "import",
          requesterAgentId,
          targetAgentId,
          requesterSessionKey: effectiveRequesterKey,
          targetSessionKey: resolvedKey,
          requestedBySessionKey: opts?.agentSessionKey,
          requestedByChannel: opts?.agentChannel,
          timeoutMs: approvalTimeoutMs,
          items: importAsk,
        });
        if (!approval.ok) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: approval.error,
            sessionKey: displayKey,
          });
        }
        importApprovalId = approval.approvalId;
        importApprovalDecision = approval.decision;
        if (approval.approved) {
          importApprovedAsk = importAsk;
        }
      }

      const finalApprovedItems = [...importAuto, ...importApprovedAsk];
      const transfer = await importTransferredKnowledge({
        cfg,
        requesterAgentId,
        targetAgentId,
        targetSessionKey: displayKey,
        exportApprovalId,
        importApprovalId,
        items: finalApprovedItems,
      });

      const transferFileRel =
        typeof transfer.filePath === "string"
          ? path
              .relative(resolveAgentWorkspaceDir(cfg, requesterAgentId), transfer.filePath)
              .replace(/\\/g, "/")
          : undefined;

      const exportDeclined = exportAsk.length - exportApprovedAsk.length;
      const importDeclined = importAsk.length - importApprovedAsk.length;
      const status =
        transfer.imported === 0 &&
        transfer.skippedDuplicate === 0 &&
        (exportDeclined > 0 || importDeclined > 0)
          ? "declined"
          : "ok";

      return jsonResult({
        runId: crypto.randomUUID(),
        status,
        sessionKey: displayKey,
        requesterAgentId,
        targetAgentId,
        candidateTotal: payloadItems.length,
        allowedByPolicy: allowedByPolicy.length,
        blockedExport,
        blockedImport,
        exportAskCount: exportAsk.length,
        importAskCount: importAsk.length,
        exportDeclined,
        importDeclined,
        exportApprovalId,
        importApprovalId,
        exportApprovalDecision,
        importApprovalDecision,
        imported: transfer.imported,
        skippedDuplicate: transfer.skippedDuplicate,
        importedFingerprints: transfer.importedFingerprints,
        transferFile: transferFileRel,
      });
    },
  };
}
