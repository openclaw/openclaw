import type { ContextBrokerIntent } from "./classifier.js";

export type ContextBrokerEvidence = {
  source: string;
  title: string;
  snippet: string;
  score: number;
};

export type ContextBrokerInjectionParams = {
  intents: ContextBrokerIntent[];
  evidence: ContextBrokerEvidence[];
  maxChars?: number;
};

function clampSnippet(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function buildContextBrokerPrependContext(
  params: ContextBrokerInjectionParams,
): string | undefined {
  if (params.intents.length === 0 || params.evidence.length === 0) {
    return undefined;
  }

  const maxChars = params.maxChars ?? 2400;
  const lines = ["Context broker:", `intent=${params.intents.join(", ")}`, "Top local evidence:"];

  for (const evidence of params.evidence) {
    lines.push(`- [${evidence.source}] ${evidence.title}`);
    lines.push(`  ${clampSnippet(evidence.snippet, 280)}`);
  }

  const rendered = lines.join("\n").trim();
  if (rendered.length <= maxChars) {
    return rendered;
  }
  return clampSnippet(rendered, maxChars);
}
