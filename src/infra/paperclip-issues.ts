import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";

type PaperclipAgentMe = {
  id?: string;
  companyId?: string;
};

type PaperclipIssueResponse = {
  id?: string;
  identifier?: string;
  status?: string;
};

export type PaperclipIssueStatus = "todo" | "in_progress" | "blocked" | "done";

type PaperclipClaimedKeyFile = {
  apiKey?: string;
  token?: string;
};

export type CreatedPaperclipTrackedIssue = {
  id: string;
  identifier?: string;
  companyId: string;
  assigneeAgentId?: string;
  status?: string;
};

export function isPaperclipRunIdRequiredError(error: unknown): boolean {
  const message = String(error ?? "");
  return /Paperclip request failed \(401\)/i.test(message) && /Agent run id required/i.test(message);
}

export function isPaperclipIssueNotFoundError(error: unknown): boolean {
  const message = String(error ?? "");
  return /Paperclip request failed \(404\)/i.test(message) && /Issue not found/i.test(message);
}

function resolveClaimedKeyPath(): string {
  return path.join(os.homedir(), ".openclaw", "workspace", "paperclip-claimed-api-key.json");
}

async function loadPaperclipApiKey(): Promise<string> {
  const filePath = resolveClaimedKeyPath();
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as PaperclipClaimedKeyFile;
  const token = parsed.apiKey?.trim() || parsed.token?.trim();
  if (!token) {
    throw new Error("Paperclip API key is missing from the local claimed-key file.");
  }
  return token;
}

async function paperclipRequest<T>(params: {
  apiUrl?: string;
  token: string;
  method: "GET" | "POST" | "PATCH";
  endpoint: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${params.apiUrl ?? DEFAULT_PAPERCLIP_API_URL}${params.endpoint}`, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.token}`,
      ...(params.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Paperclip request failed (${response.status}) ${params.endpoint}: ${body.slice(0, 240)}`,
    );
  }
  return (await response.json()) as T;
}

export function buildPaperclipTrackedIssueDescription(params: {
  receiptId: string;
  bodyText?: string;
  threadKey?: string;
  openIntentKey?: string;
  intentSummary?: string;
  programId?: string;
  parentTaskId?: string;
  role?: string;
  successCriteria?: string;
  riskLevel?: "low" | "medium" | "high" | "critical";
  confidence?: number;
  releaseGateStatus?: "not_required" | "required" | "reviewing" | "passed" | "blocked";
  phase?: string;
  currentOwner?: string;
  activeAgents?: string[];
  latestMilestone?: string;
  nextStep?: string;
  verificationEvidence?: string[];
  originChannel: "telegram" | "paperclip" | "direct";
  originMessageId?: string;
  createdByApproval?: boolean;
}): string {
  const verificationEvidence =
    Array.isArray(params.verificationEvidence) && params.verificationEvidence.length > 0
      ? params.verificationEvidence
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean)
          .slice(0, 12)
      : [];
  const lines = [
    "OpenClaw tracked work",
    `Program id: ${params.programId ?? ""}`,
    `Parent task id: ${params.parentTaskId ?? ""}`,
    `Role: ${params.role ?? ""}`,
    `Origin channel: ${params.originChannel}`,
    `Receipt id: ${params.receiptId}`,
    `Origin message id: ${params.originMessageId ?? ""}`,
    `Thread key: ${params.threadKey ?? ""}`,
    `Open intent key: ${params.openIntentKey ?? ""}`,
    `Created by approval: ${params.createdByApproval === true ? "yes" : "no"}`,
    `Phase: ${params.phase ?? ""}`,
    `Owner: ${params.currentOwner ?? ""}`,
    `Active agents: ${(params.activeAgents ?? []).join(", ")}`,
    `Success criteria: ${params.successCriteria ?? ""}`,
    `Risk level: ${params.riskLevel ?? ""}`,
    `Confidence: ${
      typeof params.confidence === "number" && Number.isFinite(params.confidence)
        ? params.confidence.toFixed(2)
        : ""
    }`,
    `Release gate: ${params.releaseGateStatus ?? ""}`,
    "",
    `Intent summary: ${params.intentSummary ?? ""}`,
    `Latest milestone: ${params.latestMilestone ?? ""}`,
    `Next step: ${params.nextStep ?? ""}`,
    "",
    "Verification evidence:",
    ...(verificationEvidence.length > 0
      ? verificationEvidence.map((entry) => `- ${entry}`)
      : ["- none yet"]),
    "",
    "Original request:",
    params.bodyText?.trim() || "(empty)",
  ];
  return lines.join("\n").trim();
}

export async function createPaperclipTrackedIssue(params: {
  title: string;
  description: string;
  priority?: "low" | "medium" | "high" | "critical";
  status?: PaperclipIssueStatus;
  assigneeAgentId?: string;
  apiUrl?: string;
}): Promise<CreatedPaperclipTrackedIssue> {
  const token = await loadPaperclipApiKey();
  const me = await paperclipRequest<PaperclipAgentMe>({
    apiUrl: params.apiUrl,
    token,
    method: "GET",
    endpoint: "/agents/me",
  });
  const companyId = String(me.companyId ?? "").trim();
  if (!companyId) {
    throw new Error("Paperclip /agents/me did not return a companyId.");
  }
  const issue = await paperclipRequest<PaperclipIssueResponse>({
    apiUrl: params.apiUrl,
    token,
    method: "POST",
    endpoint: `/companies/${companyId}/issues`,
    body: {
      title: params.title.trim(),
      description: params.description,
      status: params.status ?? "todo",
      priority: params.priority ?? "medium",
      assigneeAgentId: params.assigneeAgentId ?? me.id,
    },
  });
  const issueId = String(issue.id ?? "").trim();
  if (!issueId) {
    throw new Error("Paperclip issue create did not return an issue id.");
  }
  return {
    id: issueId,
    identifier: typeof issue.identifier === "string" ? issue.identifier.trim() || undefined : undefined,
    companyId,
    assigneeAgentId: params.assigneeAgentId ?? me.id,
    status: typeof issue.status === "string" ? issue.status : undefined,
  };
}

export async function ensurePaperclipTrackedIssue(params: {
  paperclipIssueId?: string;
  title: string;
  description: string;
  priority?: "low" | "medium" | "high" | "critical";
  status?: PaperclipIssueStatus;
  assigneeAgentId?: string;
  apiUrl?: string;
}): Promise<CreatedPaperclipTrackedIssue> {
  const existingId = params.paperclipIssueId?.trim();
  if (existingId) {
    return {
      id: existingId,
      companyId: "",
      assigneeAgentId: params.assigneeAgentId,
      status: params.status,
    };
  }
  return await createPaperclipTrackedIssue(params);
}

export async function updatePaperclipTrackedIssue(params: {
  issueId: string;
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  status?: PaperclipIssueStatus;
  assigneeAgentId?: string;
  comment?: string;
  apiUrl?: string;
}): Promise<CreatedPaperclipTrackedIssue> {
  const issueId = params.issueId.trim();
  if (!issueId) {
    throw new Error("Paperclip issue id is required.");
  }
  const token = await loadPaperclipApiKey();
  const issue = await paperclipRequest<PaperclipIssueResponse>({
    apiUrl: params.apiUrl,
    token,
    method: "PATCH",
    endpoint: `/issues/${issueId}`,
    body: {
      ...(typeof params.title === "string" ? { title: params.title.trim() } : {}),
      ...(typeof params.description === "string" ? { description: params.description } : {}),
      ...(typeof params.priority === "string" ? { priority: params.priority } : {}),
      ...(typeof params.status === "string" ? { status: params.status } : {}),
      ...(typeof params.assigneeAgentId === "string"
        ? { assigneeAgentId: params.assigneeAgentId }
        : {}),
      ...(typeof params.comment === "string" && params.comment.trim()
        ? { comment: params.comment.trim() }
        : {}),
    },
  });
  return {
    id: issueId,
    identifier: typeof issue.identifier === "string" ? issue.identifier.trim() || undefined : undefined,
    companyId: "",
    assigneeAgentId: params.assigneeAgentId,
    status: typeof issue.status === "string" ? issue.status : params.status,
  };
}
