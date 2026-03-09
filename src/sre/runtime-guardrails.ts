import fs from "node:fs/promises";

type GuardrailFailureFamily = "shell" | "rbac" | "git_auth" | "model_auth";

const RETRIEVAL_DOC_RE =
  /(knowledge-index\.md|runbook-map\.md|repo-root-model\.md|notion-postmortem-index\.md|incident-dossier)/i;
const HUMAN_CORRECTION_RE =
  /\b(wrong|actual issue|current lead is|we confirmed|this is connected|my only explanation|outdated|not the issue)\b/i;

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
  if (lines.length === 0) {
    return undefined;
  }

  let sawRetrievalDoc = false;
  let sawRepoRead = false;
  let latestHumanCorrection: string | undefined;
  const failureCounts = new Map<GuardrailFailureFamily, number>();

  for (const line of lines) {
    if (/"name":"read"/.test(line) && /"path":"([^"]+)"/.test(line)) {
      const pathMatch = /"path":"([^"]+)"/.exec(line);
      const readPath = pathMatch?.[1] ?? "";
      if (RETRIEVAL_DOC_RE.test(readPath)) {
        sawRetrievalDoc = true;
      }
      if (/\/repos\/|morpho-infra|morpho-api|openclaw-sre\//i.test(readPath)) {
        sawRepoRead = true;
      }
    }

    if (line.includes('"role":"user"')) {
      const textMatch = /"text":"([^"]+)"/.exec(line);
      const text = textMatch?.[1] ?? "";
      if (HUMAN_CORRECTION_RE.test(text)) {
        latestHumanCorrection = cleanLine(text.replace(/\\"/g, '"'));
      }
    }

    if (line.includes('"role":"toolResult"') || line.includes('"role":"assistant"')) {
      const normalized = line.replace(/\\"/g, '"');
      const family = classifyFailure(normalized);
      if (family) {
        failureCounts.set(family, (failureCounts.get(family) ?? 0) + 1);
      }
    }
  }

  const guidance: string[] = [];

  if (latestHumanCorrection) {
    guidance.push(
      `- Latest human correction overrides older bot theories unless disproved by newer live evidence: "${latestHumanCorrection}"`,
    );
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
  } catch {
    return undefined;
  }
}
