import { accessSync, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_INCIDENT_RE,
  EXACT_ARTIFACT_RE,
  extractInlineJsonTextValue,
  extractResolverFamily,
} from "./patterns.js";

type GuardrailFailureFamily = "shell" | "rbac" | "git_auth" | "model_auth";
type TranscriptPreview = { line: number; preview: string; rawText: string };

const RETRIEVAL_DOC_RE =
  /(knowledge-index\.md|runbook-map\.md|repo-root-model\.md|notion-postmortem-index\.md|incident-dossier)/i;
const DB_DATA_PLAYBOOK_RE = /db-data-incident-playbook\.md$/i;
const DEFAULT_SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT =
  "/home/node/.openclaw/skills/morpho-sre/scripts/single-vault-graphql-evidence.sh";
const HUMAN_CORRECTION_RE =
  /\b(wrong|actual issue|current lead is|we confirmed|this is connected|my only explanation|outdated|not the issue)\b/i;
const RESOLVER_TOKEN_RE = {
  vaultByAddress: /\bvaultByAddress\b/,
  vaultV2ByAddress: /\bvaultV2ByAddress\b/,
} as const;

function isSreAgent(agentId: string): boolean {
  return agentId === "sre" || agentId.startsWith("sre-");
}

function classifyFailure(text: string): GuardrailFailureFamily | null {
  if (
    /Illegal option -o pipefail|Syntax error|command not found|Permission denied|cannot find .* on PATH|doesn.?t find .* executables/i.test(
      text,
    )
  ) {
    return "shell";
  }
  if (/Forbidden.*pods\/exec|cannot create resource "pods\/exec"|kubectl exec/i.test(text)) {
    return "rbac";
  }
  if (/could not read Username for 'https:\/\/github.com'|Author identity unknown/i.test(text)) {
    return "git_auth";
  }
  if (
    /Agent failed before reply|OAuth token refresh failed|No API key found for provider|credit balance is too low|LLM request timed out/i.test(
      text,
    )
  ) {
    return "model_auth";
  }
  return null;
}

function cleanLine(text: string, maxChars = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function formatInlineCode(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}${text}${fence}`;
}

function isErrnoCode(err: unknown, code: string): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as NodeJS.ErrnoException).code === "string" &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function hasRelatedHumanCorrection(params: {
  currentHumanCorrection?: { line: number; preview: string };
  currentUserArtifact?: TranscriptPreview;
  promptHasHumanCorrection: boolean;
}): boolean {
  if (!params.currentHumanCorrection || !params.currentUserArtifact) {
    return false;
  }
  if (params.promptHasHumanCorrection) {
    return true;
  }
  return (
    params.currentHumanCorrection.line >= params.currentUserArtifact.line - 1 &&
    params.currentHumanCorrection.line <= params.currentUserArtifact.line
  );
}

/**
 * Returns the display path for the single-vault evidence helper.
 *
 * The env override stays opt-in, but it must be an absolute executable path so
 * the rendered guidance does not point at a dead helper.
 */
function singleVaultGraphqlEvidenceScriptPath(): string {
  const envPath = process.env.SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH?.trim();
  if (!envPath || !path.isAbsolute(envPath)) {
    return DEFAULT_SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT;
  }
  const normalizedPath = path.resolve(envPath);
  try {
    accessSync(normalizedPath, fsConstants.X_OK);
  } catch {
    return DEFAULT_SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT;
  }
  return normalizedPath;
}

/**
 * Builds inline SRE runtime guardrails from a JSONL transcript plus the current
 * prompt.
 *
 * `params.transcriptText` should be the raw session transcript where each line
 * is one JSON event. Returns a formatted guardrail block when the transcript or
 * prompt implies extra operator guidance, otherwise `undefined`.
 */
export function buildSreRuntimeGuardrailContextFromTranscript(params: {
  agentId: string;
  prompt: string;
  transcriptText: string;
}): string | undefined {
  if (!isSreAgent(params.agentId)) {
    return undefined;
  }
  const lines = params.transcriptText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.length === 0 &&
    !(
      DATA_INCIDENT_RE.test(params.prompt) ||
      EXACT_ARTIFACT_RE.test(params.prompt) ||
      HUMAN_CORRECTION_RE.test(params.prompt)
    )
  ) {
    return undefined;
  }

  let sawRetrievalDoc = false;
  let sawDbDataPlaybook = false;
  let sawRepoRead = false;
  let latestHumanCorrection: { line: number; preview: string } | undefined;
  let latestUserArtifact: TranscriptPreview | undefined;
  let latestDataIncidentText: string | undefined;
  const failureCounts = new Map<GuardrailFailureFamily, number>();
  const assistantTextLines: Array<{ line: number; text: string }> = [];

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (/"name":"read"/.test(line)) {
      for (const pathMatch of line.matchAll(/"path":"([^"]+)"/g)) {
        const readPath = pathMatch[1] ?? "";
        if (RETRIEVAL_DOC_RE.test(readPath)) {
          sawRetrievalDoc = true;
        }
        if (DB_DATA_PLAYBOOK_RE.test(readPath)) {
          sawDbDataPlaybook = true;
        }
        if (/\/repos\/|morpho-infra|morpho-api|openclaw-sre\//i.test(readPath)) {
          sawRepoRead = true;
        }
      }
    }

    if (line.includes('"role":"user"')) {
      const text = extractInlineJsonTextValue(line) ?? "";
      const preview = cleanLine(text);
      if (HUMAN_CORRECTION_RE.test(text)) {
        latestHumanCorrection = { line: lineNo, preview };
      }
      if (DATA_INCIDENT_RE.test(text)) {
        latestDataIncidentText = text;
      }
      if (EXACT_ARTIFACT_RE.test(text)) {
        latestUserArtifact = { line: lineNo, preview, rawText: text };
      }
    }

    if (line.includes('"role":"toolResult"') || line.includes('"role":"assistant"')) {
      const normalized = line.replace(/\\"/g, '"');
      const family = classifyFailure(normalized);
      if (family) {
        failureCounts.set(family, (failureCounts.get(family) ?? 0) + 1);
      }
    }

    if (line.includes('"role":"assistant"')) {
      const assistantText = extractInlineJsonTextValue(line);
      if (assistantText) {
        assistantTextLines.push({ line: lineNo, text: assistantText });
      }
    }
  }

  const guidance: string[] = [];
  const promptPreview = cleanLine(params.prompt);
  const promptHasHumanCorrection = HUMAN_CORRECTION_RE.test(params.prompt);
  const promptArtifact = EXACT_ARTIFACT_RE.test(params.prompt)
    ? ({
        line: Number.POSITIVE_INFINITY,
        preview: promptPreview,
        rawText: params.prompt,
      } satisfies TranscriptPreview)
    : undefined;
  const currentUserArtifact = promptArtifact ?? latestUserArtifact;
  const currentHumanCorrection = promptHasHumanCorrection
    ? { line: Number.POSITIVE_INFINITY, preview: promptPreview }
    : latestHumanCorrection;
  const currentArtifactText = currentUserArtifact?.rawText ?? params.prompt;
  const hasDataIncidentSignal = DATA_INCIDENT_RE.test(
    `${params.prompt}\n${latestDataIncidentText ?? ""}\n${currentArtifactText}`,
  );
  const hasExactArtifactSignal = EXACT_ARTIFACT_RE.test(currentArtifactText);
  const userResolver = extractResolverFamily(currentArtifactText);
  let priorResolverMismatchMessage: string | undefined;

  if (currentUserArtifact && userResolver) {
    const otherResolver =
      userResolver === "vaultV2ByAddress" ? "vaultByAddress" : "vaultV2ByAddress";
    const userResolverRe = RESOLVER_TOKEN_RE[userResolver];
    const otherResolverRe = RESOLVER_TOKEN_RE[otherResolver];
    const priorResolverMismatch = assistantTextLines.some(
      (entry) =>
        entry.line < currentUserArtifact.line &&
        otherResolverRe.test(entry.text) &&
        !userResolverRe.test(entry.text),
    );
    if (priorResolverMismatch) {
      priorResolverMismatchMessage = `- Resolver mismatch detected: older thread content mentions \`${otherResolver}\` while the latest user artifact is \`${userResolver}\`. Re-prove the path from the latest query before naming a cause.`;
    }
  }

  if (currentHumanCorrection) {
    guidance.push(
      `- Latest human correction overrides older bot theories unless disproved by newer live evidence: "${currentHumanCorrection.preview}"`,
    );
  }

  if (
    hasExactArtifactSignal &&
    (hasRelatedHumanCorrection({
      currentHumanCorrection,
      currentUserArtifact,
      promptHasHumanCorrection,
    }) ||
      priorResolverMismatchMessage)
  ) {
    guidance.push(
      "- New evidence contradicted an older theory. Explicitly retract the outdated theory in-thread before continuing from fresh live evidence.",
    );
  }

  if (hasExactArtifactSignal) {
    guidance.push(
      "- Latest user-supplied exact artifact detected. Replay that exact query/event/address first, then isolate the minimal failing field set before reusing older theories.",
    );
  }

  if (currentUserArtifact && hasDataIncidentSignal) {
    const singleVaultGraphqlEvidenceScript = formatInlineCode(
      singleVaultGraphqlEvidenceScriptPath(),
    );
    guidance.push(
      "- For single-vault API/data incidents, compare one healthy same-chain control vault, direct onchain values, and public surfaces (`vaultV2ByAddress`, `vaultV2s`, `vaultV2transactions`) before calling it chain-wide.",
    );
    guidance.push(
      `- Use ${singleVaultGraphqlEvidenceScript} when possible so the exact query replay, healthy control, and public-surface split are captured before RCA ranking.`,
    );
    guidance.push(
      "- Do not call an ingestion/provenance root cause confirmed until you add one DB row/provenance fact and one job-path or simulation fact for the affected entity.",
    );
  }

  if (hasDataIncidentSignal && !sawDbDataPlaybook) {
    guidance.push(
      "- Data-incident retrieval gate: read `references/db-data-incident-playbook.md` before more repo/code spelunking.",
    );
  }

  if (priorResolverMismatchMessage) {
    guidance.push(priorResolverMismatchMessage);
  }

  const repeatedFamilies = [...failureCounts.entries()].filter(([, count]) => count >= 2);
  for (const [family] of repeatedFamilies) {
    if (family === "shell") {
      guidance.push(
        "- Repeated shell/runtime failures detected. Avoid re-running the same shell pattern; use blocked mode or an explicit `bash -lc` wrapper if Bash-only syntax is required.",
      );
      continue;
    }
    if (family === "rbac") {
      guidance.push(
        "- Repeated RBAC exec failures detected. Stop retrying `kubectl exec`; switch to `get`, `describe`, `logs`, metrics, traces, and repo/chart inspection.",
      );
      continue;
    }
    if (family === "git_auth") {
      guidance.push(
        "- Repeated git/GitHub auth failures detected. Stop clone/fetch retry loops; use local repo/chart evidence or report the exact auth blocker.",
      );
      continue;
    }
    if (family === "model_auth") {
      guidance.push(
        "- Repeated model/auth failures detected in this thread. Keep updates concise and avoid long exploratory plans until the model/auth issue is resolved.",
      );
    }
  }

  if (sawRepoRead && !sawRetrievalDoc) {
    guidance.push(
      "- Retrieval gate: before more repo/code spelunking, read one of `knowledge-index.md`, `runbook-map.md`, or `repo-root-model.md`.",
    );
  }

  if (
    repeatedFamilies.length > 0 &&
    !/blocked by access|blocked mode|exact error|status:\s*blocked/i.test(params.prompt)
  ) {
    guidance.push(
      "- If you still do not have one successful live check, switch to blocked mode: exact failing command + exact error + no more than 3 next checks.",
    );
  }

  if (guidance.length === 0) {
    return undefined;
  }
  return `Runtime guardrails:\n${guidance.join("\n")}`;
}

export async function buildSreRuntimeGuardrailContext(params: {
  agentId: string;
  prompt: string;
  sessionFile: string;
}): Promise<string | undefined> {
  if (!isSreAgent(params.agentId)) {
    return undefined;
  }
  try {
    const transcriptText = await fs.readFile(params.sessionFile, "utf8");
    return buildSreRuntimeGuardrailContextFromTranscript({
      agentId: params.agentId,
      prompt: params.prompt,
      transcriptText,
    });
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      return undefined;
    }
    console.error("sre-guardrail-context-build-failed", {
      sessionFile: params.sessionFile,
      error: String(err),
    });
    return undefined;
  }
}
