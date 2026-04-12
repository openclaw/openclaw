import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { isChiefReplyStyleGuardTarget } from "./reply-style-guard.js";

export const CHIEF_SPECIALIST_CONSULTATION_MARKER = "## Chief Specialist Consultation Notes";

type SpecialistId = "work" | "career" | "personal";

type SpecialistKeywordConfig = {
  id: SpecialistId;
  defaultName: string;
  keywords: string[];
};

type SpecialistAgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

export type ChiefSpecialistConsultationTarget = {
  id: SpecialistId;
  name: string;
  workspaceDir: string;
  agentDir: string;
  provider?: string;
  model?: string;
};

export type ChiefSpecialistConsultation = {
  id: SpecialistId;
  name: string;
  summary: string;
  recommendation: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  risks: string[];
  followUp?: string;
  rawText: string;
};

export type ChiefSpecialistConsultationRunResult = {
  consultations: ChiefSpecialistConsultation[];
  chiefMemoryPath?: string;
  specialistBriefPaths: string[];
};

type ConsultationRunPayload = {
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  timeoutMs: number;
  runId: string;
  sessionFile: string;
  trigger: "manual";
  spawnedBy?: string | null;
  allowGatewaySubagentBinding: true;
  disableMessageTool: true;
  bootstrapContextMode: "lightweight";
  verboseLevel: "off";
  extraSystemPrompt?: string;
};

type ConsultationAgentRunner = (params: ConsultationRunPayload) => Promise<{
  payloads?: Array<{ text?: string | null }>;
}>;

const SPECIALIST_KEYWORDS: SpecialistKeywordConfig[] = [
  {
    id: "work",
    defaultName: "Malik",
    keywords: [
      "work",
      "job",
      "client",
      "project",
      "repo",
      "code",
      "engineering",
      "technical",
      "product",
      "startup",
      "core",
      "research engineer",
    ],
  },
  {
    id: "career",
    defaultName: "Leila",
    keywords: [
      "career",
      "resume",
      "cv",
      "masters",
      "master's",
      "phd",
      "internship",
      "application",
      "portfolio",
      "positioning",
      "future",
      "long-term",
    ],
  },
  {
    id: "personal",
    defaultName: "Nour",
    keywords: [
      "personal",
      "personally",
      "stress",
      "burnout",
      "mental",
      "health",
      "sleep",
      "routine",
      "discipline",
      "motivation",
      "faith",
      "prayer",
      "family",
      "confidence",
    ],
  },
];

function trimToSingleLine(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function splitModelRef(ref?: string): { provider?: string; model?: string } {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return {};
  }
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) {
    return { model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slashIdx),
    model: trimmed.slice(slashIdx + 1),
  };
}

function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): SpecialistAgentEntry | undefined {
  return cfg.agents?.list?.find((entry) => entry.id === agentId);
}

function resolveConfiguredSpecialistTargets(
  cfg: OpenClawConfig,
): Map<SpecialistId, ChiefSpecialistConsultationTarget> {
  const targets = new Map<SpecialistId, ChiefSpecialistConsultationTarget>();
  const defaultModel = cfg.agents?.defaults?.model?.primary;
  for (const specialist of SPECIALIST_KEYWORDS) {
    const entry = resolveAgentEntry(cfg, specialist.id);
    if (!entry?.workspace || !entry.agentDir) {
      continue;
    }
    const { provider, model } = splitModelRef(entry.model?.primary ?? defaultModel);
    targets.set(specialist.id, {
      id: specialist.id,
      name: trimToSingleLine(entry.name, specialist.defaultName),
      workspaceDir: entry.workspace,
      agentDir: entry.agentDir,
      provider,
      model,
    });
  }
  return targets;
}

function isGreetingLike(userText: string): boolean {
  const normalized = userText.trim().toLowerCase();
  return /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)\b[!.?]*$/.test(
    normalized,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesKeyword(userText: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(keyword).replaceAll("\\ ", "\\s+")}\\b`, "i");
  return pattern.test(userText);
}

function scoreKeywordMatches(userText: string, specialist: SpecialistKeywordConfig): number {
  const normalized = userText.trim().toLowerCase();
  let score = 0;
  if (
    matchesKeyword(normalized, specialist.id) ||
    matchesKeyword(normalized, specialist.defaultName.toLowerCase())
  ) {
    score += 4;
  }
  for (const keyword of specialist.keywords) {
    if (matchesKeyword(normalized, keyword.toLowerCase())) {
      score += 1;
    }
  }
  return score;
}

export function hasChiefSpecialistConsultationPrompt(existingPrompt?: string): boolean {
  return existingPrompt?.includes(CHIEF_SPECIALIST_CONSULTATION_MARKER) ?? false;
}

export function appendChiefSpecialistConsultationPrompt(
  existingPrompt: string | undefined,
  consultationPrompt: string | undefined,
): string | undefined {
  if (!consultationPrompt) {
    return existingPrompt;
  }
  if (hasChiefSpecialistConsultationPrompt(existingPrompt)) {
    return existingPrompt;
  }
  return existingPrompt ? `${existingPrompt}\n\n${consultationPrompt}` : consultationPrompt;
}

export function resolveChiefSpecialistTargets(params: {
  cfg: OpenClawConfig;
  userText?: string;
}): ChiefSpecialistConsultationTarget[] {
  const userText = params.userText?.trim() ?? "";
  if (!userText || isGreetingLike(userText)) {
    return [];
  }
  const configured = resolveConfiguredSpecialistTargets(params.cfg);
  if (configured.size === 0) {
    return [];
  }
  const scored = SPECIALIST_KEYWORDS.map((specialist) => ({
    specialist,
    target: configured.get(specialist.id),
    score: scoreKeywordMatches(userText, specialist),
  }))
    .filter((entry) => entry.target && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.specialist.id.localeCompare(b.specialist.id));
  return scored.map((entry) => entry.target as ChiefSpecialistConsultationTarget);
}

function buildSpecialistConsultationPrompt(params: {
  specialist: ChiefSpecialistConsultationTarget;
  chiefAgentId: string;
  userText: string;
}): string {
  return [
    "Internal chief consultation.",
    `Chief agent: ${params.chiefAgentId}.`,
    `Specialist agent: ${params.specialist.name} (${params.specialist.id}).`,
    "Return exactly one JSON object with these keys:",
    "summary, recommendation, confidence, evidence, risks, follow_up",
    "Rules:",
    "- Stay inside your specialist domain.",
    "- Be concise and concrete.",
    "- Do not address the user directly.",
    "- Do not mention this internal consultation.",
    '- confidence must be one of "high", "medium", or "low".',
    "- evidence and risks must be short string arrays.",
    "",
    "User message:",
    params.userText,
  ].join("\n");
}

function extractReplyText(payloads?: Array<{ text?: string | null }>): string {
  return (
    payloads
      ?.map((payload) => (typeof payload?.text === "string" ? payload.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim() ?? ""
  );
}

function extractJsonCandidate(rawText: string): string | undefined {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    return fenced;
  }
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return rawText.slice(start, end + 1);
  }
  return undefined;
}

function normalizeListField(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => trimToSingleLine(typeof item === "string" ? item : String(item), ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseConsultationResponse(params: {
  rawText: string;
  specialist: ChiefSpecialistConsultationTarget;
}): ChiefSpecialistConsultation {
  const rawText = params.rawText.trim();
  const jsonCandidate = extractJsonCandidate(rawText);
  let parsed: Record<string, unknown> | undefined;
  if (jsonCandidate) {
    try {
      parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
  }
  const normalizedConfidence = trimToSingleLine(
    typeof parsed?.confidence === "string" ? parsed.confidence : undefined,
    "medium",
  ).toLowerCase();
  const confidence =
    normalizedConfidence === "high" || normalizedConfidence === "low"
      ? normalizedConfidence
      : "medium";
  const fallback = truncate(trimToSingleLine(rawText, "No consultation output."), 240);
  const summary = truncate(
    trimToSingleLine(typeof parsed?.summary === "string" ? parsed.summary : undefined, fallback),
    240,
  );
  const recommendation = truncate(
    trimToSingleLine(
      typeof parsed?.recommendation === "string" ? parsed.recommendation : undefined,
      summary,
    ),
    240,
  );
  const followUp = truncate(
    trimToSingleLine(typeof parsed?.follow_up === "string" ? parsed.follow_up : undefined, ""),
    180,
  );
  return {
    id: params.specialist.id,
    name: params.specialist.name,
    summary,
    recommendation,
    confidence,
    evidence: normalizeListField(parsed?.evidence, 4),
    risks: normalizeListField(parsed?.risks, 4),
    followUp: followUp || undefined,
    rawText: rawText || fallback,
  };
}

function buildConsultationSessionArtifacts(params: {
  workspaceDir: string;
  specialistId: string;
  slug: string;
}) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const shortId = crypto.randomUUID().slice(0, 8);
  const relDir = path.join("tmp", "consultations");
  const filename = `${timestamp}-${params.specialistId}-${params.slug || "consult"}-${shortId}.json`;
  return {
    sessionId: `consult-${params.specialistId}-${shortId}`,
    runId: `consult-run-${shortId}`,
    sessionFile: path.join(params.workspaceDir, relDir, filename),
  };
}

async function writeConsultationArtifacts(params: {
  chiefWorkspaceDir: string;
  userText: string;
  consultations: ChiefSpecialistConsultation[];
  specialistTargets: Map<SpecialistId, ChiefSpecialistConsultationTarget>;
}): Promise<{ chiefMemoryPath?: string; specialistBriefPaths: string[] }> {
  const iso = new Date().toISOString();
  const dateStamp = iso.slice(0, 10);
  const querySlug = slugify(params.userText) || "consultation";
  const shortId = crypto.randomUUID().slice(0, 8);
  const specialistBriefPaths: string[] = [];

  for (const consultation of params.consultations) {
    const specialist = params.specialistTargets.get(consultation.id);
    if (!specialist) {
      continue;
    }
    const briefDir = path.join(specialist.workspaceDir, "reports", "briefs");
    await fs.mkdir(briefDir, { recursive: true });
    const briefPath = path.join(
      briefDir,
      `${dateStamp}-chief-consult-${consultation.id}-${querySlug}-${shortId}.md`,
    );
    const briefBody = [
      "# Chief Consultation Brief",
      `- Time: ${iso}`,
      `- Specialist: ${consultation.name} (${consultation.id})`,
      "",
      "## User Message",
      params.userText,
      "",
      "## Summary",
      consultation.summary,
      "",
      "## Recommendation",
      consultation.recommendation,
      "",
      "## Confidence",
      consultation.confidence,
      "",
      "## Evidence",
      ...(consultation.evidence.length > 0
        ? consultation.evidence.map((item) => `- ${item}`)
        : ["- None"]),
      "",
      "## Risks",
      ...(consultation.risks.length > 0
        ? consultation.risks.map((item) => `- ${item}`)
        : ["- None"]),
      "",
      "## Follow Up",
      consultation.followUp ?? "None",
      "",
      "## Raw Output",
      "```text",
      consultation.rawText,
      "```",
      "",
    ].join("\n");
    await fs.writeFile(briefPath, briefBody, "utf8");
    specialistBriefPaths.push(briefPath);
  }

  const memoryDir = path.join(params.chiefWorkspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const chiefMemoryPath = path.join(
    memoryDir,
    `${dateStamp}-chief-specialist-consult-${querySlug}-${shortId}.md`,
  );
  const chiefMemoryBody = [
    "# Chief Specialist Consultation Memory",
    `- Time: ${iso}`,
    `- Consulted: ${params.consultations.map((item) => `${item.name} (${item.id})`).join(", ")}`,
    "",
    "## User Message",
    params.userText,
    "",
    "## Advice",
    ...params.consultations.flatMap((consultation) => [
      `### ${consultation.name} (${consultation.id})`,
      `- Summary: ${consultation.summary}`,
      `- Recommendation: ${consultation.recommendation}`,
      `- Confidence: ${consultation.confidence}`,
      `- Evidence: ${consultation.evidence.join(" | ") || "None"}`,
      `- Risks: ${consultation.risks.join(" | ") || "None"}`,
      `- Follow Up: ${consultation.followUp ?? "None"}`,
      "",
    ]),
  ].join("\n");
  await fs.writeFile(chiefMemoryPath, chiefMemoryBody, "utf8");

  return {
    chiefMemoryPath,
    specialistBriefPaths,
  };
}

export function buildChiefSpecialistConsultationSystemPrompt(
  consultations: ChiefSpecialistConsultation[],
): string | undefined {
  if (consultations.length === 0) {
    return undefined;
  }
  return [
    CHIEF_SPECIALIST_CONSULTATION_MARKER,
    "Internal specialist consults completed. Use them as advisory input for this answer.",
    "Answer the user directly. Do not mention internal consultation unless the user explicitly asks.",
    "If specialists disagree, reconcile the tradeoff instead of repeating both views.",
    ...consultations.flatMap((consultation) => [
      `- ${consultation.name} (${consultation.id}) summary: ${consultation.summary}`,
      `- ${consultation.name} (${consultation.id}) recommendation: ${consultation.recommendation}`,
      `- ${consultation.name} (${consultation.id}) confidence: ${consultation.confidence}`,
      ...(consultation.evidence.length > 0
        ? [
            `- ${consultation.name} (${consultation.id}) evidence: ${consultation.evidence.join(" | ")}`,
          ]
        : []),
      ...(consultation.risks.length > 0
        ? [`- ${consultation.name} (${consultation.id}) risks: ${consultation.risks.join(" | ")}`]
        : []),
      ...(consultation.followUp
        ? [`- ${consultation.name} (${consultation.id}) follow-up: ${consultation.followUp}`]
        : []),
    ]),
  ].join("\n");
}

export async function runChiefSpecialistConsultations(params: {
  cfg: OpenClawConfig;
  chiefAgentId?: string;
  chiefWorkspaceDir?: string;
  chiefSessionKey?: string;
  userText?: string;
  chiefTimeoutMs: number;
  runConsultation: ConsultationAgentRunner;
}): Promise<ChiefSpecialistConsultationRunResult | undefined> {
  const chiefWorkspaceDir = params.chiefWorkspaceDir?.trim();
  const userText = params.userText?.trim();
  if (
    !chiefWorkspaceDir ||
    !userText ||
    !isChiefReplyStyleGuardTarget({
      agentId: params.chiefAgentId,
      workspaceDir: chiefWorkspaceDir,
    })
  ) {
    return undefined;
  }
  const targets = resolveChiefSpecialistTargets({
    cfg: params.cfg,
    userText,
  });
  if (targets.length === 0) {
    return undefined;
  }
  const perSpecialistTimeoutMs = Math.max(
    15_000,
    Math.min(45_000, Math.floor(params.chiefTimeoutMs * 0.25)),
  );
  const slug = slugify(userText) || "consult";
  const runs = await Promise.allSettled(
    targets.map(async (target) => {
      const artifacts = buildConsultationSessionArtifacts({
        workspaceDir: target.workspaceDir,
        specialistId: target.id,
        slug,
      });
      await fs.mkdir(path.dirname(artifacts.sessionFile), { recursive: true });
      const rawResult = await params.runConsultation({
        sessionId: artifacts.sessionId,
        sessionKey: undefined,
        agentId: target.id,
        agentDir: target.agentDir,
        workspaceDir: target.workspaceDir,
        config: params.cfg,
        prompt: buildSpecialistConsultationPrompt({
          specialist: target,
          chiefAgentId: params.chiefAgentId ?? "chief",
          userText,
        }),
        provider: target.provider,
        model: target.model,
        timeoutMs: perSpecialistTimeoutMs,
        runId: artifacts.runId,
        sessionFile: artifacts.sessionFile,
        trigger: "manual",
        spawnedBy: params.chiefSessionKey ?? null,
        allowGatewaySubagentBinding: true,
        disableMessageTool: true,
        bootstrapContextMode: "lightweight",
        verboseLevel: "off",
        extraSystemPrompt:
          "This is an internal consultation for the chief agent. Output only the requested JSON.",
      });
      const rawText = extractReplyText(rawResult.payloads);
      if (!rawText) {
        return undefined;
      }
      return parseConsultationResponse({
        rawText,
        specialist: target,
      });
    }),
  );
  const consultations = runs
    .filter(
      (entry): entry is PromiseFulfilledResult<ChiefSpecialistConsultation | undefined> =>
        entry.status === "fulfilled",
    )
    .map((entry) => entry.value)
    .filter((entry): entry is ChiefSpecialistConsultation => Boolean(entry));
  if (consultations.length === 0) {
    return undefined;
  }
  const specialistTargets = new Map(targets.map((target) => [target.id, target]));
  const artifacts = await writeConsultationArtifacts({
    chiefWorkspaceDir,
    userText,
    consultations,
    specialistTargets,
  });
  return {
    consultations,
    chiefMemoryPath: artifacts.chiefMemoryPath,
    specialistBriefPaths: artifacts.specialistBriefPaths,
  };
}

export async function maybeBuildChiefSpecialistConsultationPrompt(params: {
  cfg: OpenClawConfig;
  chiefAgentId?: string;
  chiefWorkspaceDir?: string;
  chiefSessionKey?: string;
  userText?: string;
  chiefTimeoutMs: number;
  existingPrompt?: string;
  runConsultation: ConsultationAgentRunner;
}): Promise<string | undefined> {
  if (hasChiefSpecialistConsultationPrompt(params.existingPrompt)) {
    return undefined;
  }
  const result = await runChiefSpecialistConsultations(params);
  return buildChiefSpecialistConsultationSystemPrompt(result?.consultations ?? []);
}
