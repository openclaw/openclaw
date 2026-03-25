import { accessSync, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_INCIDENT_RE,
  EXACT_ARTIFACT_RE,
  extractInlineJsonTextValue,
  extractResolverFamily,
  matchesAccessGrant,
  matchesHumanCorrection,
} from "./patterns.js";

type GuardrailFailureFamily = "shell" | "rbac" | "git_auth" | "model_auth";
type TranscriptPreview = { line: number; preview: string; rawText: string };
type HumanCorrectionPreview = { line: number; preview: string; rawText: string };
type AssistantTextLine = { line: number; text: string };
type TranscriptScan = {
  sawRetrievalDoc: boolean;
  sawDbDataPlaybook: boolean;
  sawRepoRead: boolean;
  latestHumanCorrection?: HumanCorrectionPreview;
  latestUserArtifact?: TranscriptPreview;
  latestDataIncidentText?: string;
  failureCounts: Map<GuardrailFailureFamily, number>;
  assistantTextLines: AssistantTextLine[];
};
type GuardrailSignals = {
  promptHasHumanCorrection: boolean;
  currentUserArtifact?: TranscriptPreview;
  currentHumanCorrection?: HumanCorrectionPreview;
  hasDataIncidentSignal: boolean;
  hasExactArtifactSignal: boolean;
  userResolver: ReturnType<typeof extractResolverFamily>;
};

const RETRIEVAL_DOC_RE =
  /(knowledge-index\.md|runbook-map\.md|repo-root-model\.md|notion-postmortem-index\.md|incident-dossier)/i;
const DB_DATA_PLAYBOOK_RE = /db-data-incident-playbook\.md$/i;
const DEFAULT_OPENCLAW_STATE_DIR = "/home/node/.openclaw";
const SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_NAME = "single-vault-graphql-evidence.sh";
const VERCEL_READONLY_SCRIPT_NAME = "vercel-readonly.sh";
const DEFAULT_SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT = path.join(
  DEFAULT_OPENCLAW_STATE_DIR,
  "skills",
  "morpho-sre",
  "scripts",
  SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_NAME,
);
const DEFAULT_VERCEL_READONLY_SCRIPT = path.join(
  DEFAULT_OPENCLAW_STATE_DIR,
  "skills",
  "vercel",
  VERCEL_READONLY_SCRIPT_NAME,
);
// Match the retained prompt/transcript signal budget so routing helpers and
// regex scanners reason over the same bounded slice of evidence.
const GUARDRAIL_SIGNAL_MAX_CHARS = 4_000;
const MAX_ASSISTANT_LINES_FOR_VERCEL_CONTEXT = 20;
const VERCEL_SURFACE_RE = /\bvercel\b/i;
const NEGATED_VERCEL_CONTEXT_RE = /\b(?:non[-\s]?vercel|not vercel|unrelated to vercel)\b/i;
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

// Keep retained transcript/prompt snippets aligned with the 4k signal scanners.
function sliceGuardrailSignalText(text: string): string {
  return text.length <= GUARDRAIL_SIGNAL_MAX_CHARS
    ? text
    : text.slice(0, GUARDRAIL_SIGNAL_MAX_CHARS);
}

function buildVercelContextText(params: {
  humanCorrectionText: string;
  prompt: string;
  assistantTextLines: AssistantTextLine[];
}): string {
  const prefixText = sliceGuardrailSignalText(
    [
      sliceGuardrailSignalText(params.humanCorrectionText),
      sliceGuardrailSignalText(params.prompt),
    ].join("\n"),
  );
  if (prefixText.length >= GUARDRAIL_SIGNAL_MAX_CHARS) {
    return prefixText;
  }

  // slice(-N) intentionally clamps when fewer assistant lines exist.
  const assistantTail = params.assistantTextLines
    .slice(-MAX_ASSISTANT_LINES_FOR_VERCEL_CONTEXT)
    .map((entry) => sliceGuardrailSignalText(entry.text));
  if (assistantTail.length === 0) {
    return prefixText;
  }

  const separatorBudget = 1;
  const tailBudget = GUARDRAIL_SIGNAL_MAX_CHARS - prefixText.length - separatorBudget;
  if (tailBudget <= 0) {
    return prefixText;
  }

  const assistantTailText = assistantTail.join("\n");
  const boundedAssistantTail =
    assistantTailText.length <= tailBudget
      ? assistantTailText
      : assistantTailText.slice(assistantTailText.length - tailBudget);
  return `${prefixText}\n${boundedAssistantTail}`;
}

function hasPromptGuardrailSignal(prompt: string): boolean {
  return (
    DATA_INCIDENT_RE.test(prompt) ||
    EXACT_ARTIFACT_RE.test(prompt) ||
    matchesHumanCorrection(prompt)
  );
}

function formatInlineCode(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}${text}${fence}`;
}

/**
 * POSIX-safe single-arg quoting for display commands rendered into prompts.
 * Handles single quotes via close-quote, escaped quote, reopen-quote.
 * Example: foo'bar -> 'foo'"'"'bar'
 */
export function shellEscapeSingleArg(value: string): string {
  const singleQuoteEscape = `'"'"'`;
  return `'${value.replace(/'/g, singleQuoteEscape)}'`;
}

function buildReadonlyBashCommand(scriptPath: string, ...args: string[]): string {
  const renderedArgs = [scriptPath, ...args].map(shellEscapeSingleArg).join(" ");
  return formatInlineCode(`bash ${renderedArgs}`);
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
  currentHumanCorrection?: HumanCorrectionPreview;
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

function isExecutablePath(scriptPath: string): boolean {
  try {
    accessSync(scriptPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultSingleVaultGraphqlEvidenceScriptPath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  const normalizedStateDir =
    stateDir && path.isAbsolute(stateDir) ? path.resolve(stateDir) : DEFAULT_OPENCLAW_STATE_DIR;
  const helperPath = path.join(
    normalizedStateDir,
    "skills",
    "morpho-sre",
    "scripts",
    SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_NAME,
  );
  if (isExecutablePath(helperPath)) {
    return helperPath;
  }
  if (
    helperPath !== DEFAULT_SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT &&
    isExecutablePath(DEFAULT_SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT)
  ) {
    return DEFAULT_SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT;
  }
  return SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_NAME;
}

/**
 * Returns the display path for the single-vault evidence helper.
 *
 * The env override stays opt-in, but it must be an absolute executable path so
 * the rendered guidance does not point at a dead helper. When the seeded
 * runtime helper is absent, fall back to the bare helper name instead of a
 * stale absolute path.
 */
function singleVaultGraphqlEvidenceScriptPath(): string {
  const envPath = process.env.SINGLE_VAULT_GRAPHQL_EVIDENCE_SCRIPT_PATH?.trim();
  if (envPath && path.isAbsolute(envPath)) {
    const normalizedPath = path.resolve(envPath);
    if (isExecutablePath(normalizedPath)) {
      return normalizedPath;
    }
  }
  return defaultSingleVaultGraphqlEvidenceScriptPath();
}

/**
 * Returns the display path for the read-only Vercel helper.
 *
 * Invalid overrides fail closed to the seeded helper or bare helper name. This
 * path is rendered into operator guidance, so fallback stays quiet instead of
 * emitting warnings into prompts or Slack-visible transcripts. The bare helper
 * name is the last-resort fallback so copied commands still stay readable even
 * when no executable helper is present yet.
 */
function resolveVercelReadonlyScriptPath(): string {
  const configuredSkillDir = process.env.OPENCLAW_VERCEL_SKILL_DIR?.trim();
  if (configuredSkillDir && path.isAbsolute(configuredSkillDir)) {
    const configuredScriptPath = path.join(
      path.resolve(configuredSkillDir),
      VERCEL_READONLY_SCRIPT_NAME,
    );
    if (isExecutablePath(configuredScriptPath)) {
      return configuredScriptPath;
    }
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  const normalizedStateDir =
    stateDir && path.isAbsolute(stateDir) ? path.resolve(stateDir) : DEFAULT_OPENCLAW_STATE_DIR;
  const helperPath = path.join(normalizedStateDir, "skills", "vercel", VERCEL_READONLY_SCRIPT_NAME);
  if (isExecutablePath(helperPath)) {
    return helperPath;
  }
  if (
    helperPath !== DEFAULT_VERCEL_READONLY_SCRIPT &&
    isExecutablePath(DEFAULT_VERCEL_READONLY_SCRIPT)
  ) {
    return DEFAULT_VERCEL_READONLY_SCRIPT;
  }
  return VERCEL_READONLY_SCRIPT_NAME;
}

// Validates the Vercel token is present and non-empty before running CLI probes.
// The shell `case` word treats `${VERCEL_TOKEN-}` as data, not executable code,
// so this stays data-only while still rejecting empty/whitespace-only values.
// Deliberately avoid pinning a vendor token format here; prompt probes only
// need a safe presence check. Length/charset checks would be vendor guesses
// that risk false negatives for future token formats.
function buildVercelTokenProbeCommand(): string {
  return formatInlineCode(
    `case \${VERCEL_TOKEN-} in ''|*[[:space:]]*) ;; *) echo "VERCEL_TOKEN=set";; esac`,
  );
}

function buildVercelAccessGuidance(): string[] {
  const helperPath = resolveVercelReadonlyScriptPath();
  const vercelWhoamiCommand = buildReadonlyBashCommand(helperPath, "whoami");
  const vercelTeamsCommand = buildReadonlyBashCommand(
    helperPath,
    "teams",
    "list",
    "--format",
    "json",
  );
  const vercelTokenCommand = buildVercelTokenProbeCommand();
  return [
    `- A human says Vercel access is now available. Treat older Vercel blocked/no-access claims as stale and rerun ${vercelTokenCommand}, ${vercelWhoamiCommand}, and ${vercelTeamsCommand} before replying.`,
  ];
}

function scanTranscriptLines(lines: string[]): TranscriptScan {
  const scan: TranscriptScan = {
    sawRetrievalDoc: false,
    sawDbDataPlaybook: false,
    sawRepoRead: false,
    latestHumanCorrection: undefined,
    latestUserArtifact: undefined,
    latestDataIncidentText: undefined,
    failureCounts: new Map<GuardrailFailureFamily, number>(),
    assistantTextLines: [],
  };

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (/"name":"read"/.test(line)) {
      for (const pathMatch of line.matchAll(/"path":"([^"]+)"/g)) {
        const readPath = pathMatch[1] ?? "";
        if (RETRIEVAL_DOC_RE.test(readPath)) {
          scan.sawRetrievalDoc = true;
        }
        if (DB_DATA_PLAYBOOK_RE.test(readPath)) {
          scan.sawDbDataPlaybook = true;
        }
        if (/\/repos\/|morpho-infra|morpho-api|openclaw-sre\//i.test(readPath)) {
          scan.sawRepoRead = true;
        }
      }
    }

    if (line.includes('"role":"user"')) {
      const text = extractInlineJsonTextValue(line) ?? "";
      const signalText = sliceGuardrailSignalText(text);
      const preview = cleanLine(signalText);
      if (matchesHumanCorrection(signalText)) {
        scan.latestHumanCorrection = { line: lineNo, preview, rawText: signalText };
      }
      if (DATA_INCIDENT_RE.test(signalText)) {
        scan.latestDataIncidentText = signalText;
      }
      if (EXACT_ARTIFACT_RE.test(signalText)) {
        scan.latestUserArtifact = { line: lineNo, preview, rawText: signalText };
      }
    }

    if (line.includes('"role":"toolResult"') || line.includes('"role":"assistant"')) {
      const normalized = line.replace(/\\"/g, '"');
      const family = classifyFailure(normalized);
      if (family) {
        scan.failureCounts.set(family, (scan.failureCounts.get(family) ?? 0) + 1);
      }
    }

    if (line.includes('"role":"assistant"')) {
      const assistantText = extractInlineJsonTextValue(line);
      if (assistantText) {
        scan.assistantTextLines.push({ line: lineNo, text: assistantText });
      }
    }
  }

  return scan;
}

function buildPromptArtifact(prompt: string): TranscriptPreview | undefined {
  const signalText = sliceGuardrailSignalText(prompt);
  if (!EXACT_ARTIFACT_RE.test(signalText)) {
    return undefined;
  }
  return {
    line: Number.POSITIVE_INFINITY,
    preview: cleanLine(signalText),
    rawText: signalText,
  };
}

function resolveGuardrailSignals(params: {
  prompt: string;
  latestDataIncidentText?: string;
  latestUserArtifact?: TranscriptPreview;
  latestHumanCorrection?: HumanCorrectionPreview;
}): GuardrailSignals {
  const promptSignalText = sliceGuardrailSignalText(params.prompt);
  const promptHasHumanCorrection = matchesHumanCorrection(promptSignalText);
  const promptArtifact = buildPromptArtifact(promptSignalText);
  const currentUserArtifact = promptArtifact ?? params.latestUserArtifact;
  const currentHumanCorrection = promptHasHumanCorrection
    ? {
        line: Number.POSITIVE_INFINITY,
        preview: cleanLine(promptSignalText),
        rawText: promptSignalText,
      }
    : params.latestHumanCorrection;
  const currentArtifactText = currentUserArtifact?.rawText ?? promptSignalText;

  return {
    promptHasHumanCorrection,
    currentUserArtifact,
    currentHumanCorrection,
    hasDataIncidentSignal: DATA_INCIDENT_RE.test(
      `${promptSignalText}\n${params.latestDataIncidentText ?? ""}\n${currentArtifactText}`,
    ),
    hasExactArtifactSignal: EXACT_ARTIFACT_RE.test(currentArtifactText),
    userResolver: extractResolverFamily(currentArtifactText),
  };
}

function buildPriorResolverMismatchMessage(params: {
  currentUserArtifact?: TranscriptPreview;
  userResolver: ReturnType<typeof extractResolverFamily>;
  assistantTextLines: AssistantTextLine[];
}): string | undefined {
  const currentUserArtifact = params.currentUserArtifact;
  if (!currentUserArtifact || !params.userResolver) {
    return undefined;
  }
  const otherResolver =
    params.userResolver === "vaultV2ByAddress" ? "vaultByAddress" : "vaultV2ByAddress";
  const userResolverRe = RESOLVER_TOKEN_RE[params.userResolver];
  const otherResolverRe = RESOLVER_TOKEN_RE[otherResolver];
  const priorResolverMismatch = params.assistantTextLines.some(
    (entry) =>
      entry.line < currentUserArtifact.line &&
      otherResolverRe.test(entry.text) &&
      !userResolverRe.test(entry.text),
  );

  if (!priorResolverMismatch) {
    return undefined;
  }
  return `- Resolver mismatch detected: older thread content mentions \`${otherResolver}\` while the latest user artifact is \`${params.userResolver}\`. Re-prove the path from the latest query before naming a cause.`;
}

function appendRepeatedFailureGuidance(
  guidance: string[],
  failureCounts: Map<GuardrailFailureFamily, number>,
): GuardrailFailureFamily[] {
  const repeatedFamilies = [...failureCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([family]) => family);

  for (const family of repeatedFamilies) {
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

  return repeatedFamilies;
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
  if (lines.length === 0 && !hasPromptGuardrailSignal(params.prompt)) {
    return undefined;
  }
  const transcriptScan = scanTranscriptLines(lines);
  const guidance: string[] = [];
  const guardrailSignals = resolveGuardrailSignals({
    prompt: params.prompt,
    latestDataIncidentText: transcriptScan.latestDataIncidentText,
    latestUserArtifact: transcriptScan.latestUserArtifact,
    latestHumanCorrection: transcriptScan.latestHumanCorrection,
  });
  const priorResolverMismatchMessage = buildPriorResolverMismatchMessage({
    currentUserArtifact: guardrailSignals.currentUserArtifact,
    userResolver: guardrailSignals.userResolver,
    assistantTextLines: transcriptScan.assistantTextLines,
  });

  if (guardrailSignals.currentHumanCorrection) {
    guidance.push(
      `- Latest human correction overrides older bot theories unless disproved by newer live evidence: "${guardrailSignals.currentHumanCorrection.preview}"`,
    );
    if (matchesAccessGrant(guardrailSignals.currentHumanCorrection.rawText)) {
      const vercelContextText = buildVercelContextText({
        humanCorrectionText: guardrailSignals.currentHumanCorrection.rawText,
        prompt: params.prompt,
        assistantTextLines: transcriptScan.assistantTextLines,
      });
      if (
        VERCEL_SURFACE_RE.test(vercelContextText) &&
        !NEGATED_VERCEL_CONTEXT_RE.test(vercelContextText)
      ) {
        guidance.push(...buildVercelAccessGuidance());
      } else {
        guidance.push(
          "- A human says access/permissions are now available. Treat older blocked/no-access claims as stale and rerun a live probe on that surface before replying.",
        );
      }
    }
  }

  if (
    guardrailSignals.hasExactArtifactSignal &&
    (hasRelatedHumanCorrection({
      currentHumanCorrection: guardrailSignals.currentHumanCorrection,
      currentUserArtifact: guardrailSignals.currentUserArtifact,
      promptHasHumanCorrection: guardrailSignals.promptHasHumanCorrection,
    }) ||
      priorResolverMismatchMessage)
  ) {
    guidance.push(
      "- New evidence contradicted an older theory. Explicitly retract the outdated theory in-thread before continuing from fresh live evidence.",
    );
  }

  if (guardrailSignals.hasExactArtifactSignal) {
    guidance.push(
      "- Latest user-supplied exact artifact detected. Replay that exact query/event/address first, then isolate the minimal failing field set before reusing older theories.",
    );
  }

  if (guardrailSignals.currentUserArtifact && guardrailSignals.hasDataIncidentSignal) {
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

  if (guardrailSignals.hasDataIncidentSignal && !transcriptScan.sawDbDataPlaybook) {
    guidance.push(
      "- Data-incident retrieval gate: read `references/db-data-incident-playbook.md` before more repo/code spelunking.",
    );
  }

  if (priorResolverMismatchMessage) {
    guidance.push(priorResolverMismatchMessage);
  }

  const repeatedFamilies = appendRepeatedFailureGuidance(guidance, transcriptScan.failureCounts);

  if (transcriptScan.sawRepoRead && !transcriptScan.sawRetrievalDoc) {
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
