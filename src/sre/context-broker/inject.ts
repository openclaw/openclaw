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

function labelForSource(source: string): string {
  switch (source) {
    case "memory":
      return "Prior work";
    case "incident-dossier":
      return "Incident memory";
    case "seed-knowledge":
      return "Seeded incident docs";
    case "relationship-index":
      return "Related graph";
    case "relationship-knowledge":
      return "Shell graph facts";
    case "repo-ownership":
      return "Repo ownership";
    default:
      return source;
  }
}

export function buildContextBrokerPrependContext(
  params: ContextBrokerInjectionParams,
): string | undefined {
  if (params.intents.length === 0 || params.evidence.length === 0) {
    return undefined;
  }

  const maxChars = params.maxChars ?? 2400;
  const grouped = new Map<string, ContextBrokerEvidence[]>();
  for (const evidence of params.evidence) {
    const list = grouped.get(evidence.source) ?? [];
    list.push(evidence);
    grouped.set(evidence.source, list);
  }

  const lines = ["Context broker packet:", `intent=${params.intents.join(", ")}`];

  if (
    params.intents.includes("data-integrity-investigation") ||
    params.intents.includes("postgres-internals") ||
    params.intents.includes("read-consistency-incident")
  ) {
    lines.push("DB-first checks:");
    lines.push(
      "- resolve DB target and run schema, data, and PG internal queries before ranking root cause",
    );
    lines.push(
      "- prefer replay lag, pg_stat_activity, pg_stat_statements, pg_stat_database_conflicts, and routing/topology facts",
    );
    lines.push(
      "- treat seeded incident docs as priors, not proof; keep multiple plausible hypotheses until live evidence narrows them",
    );
  }

  for (const [source, evidenceList] of grouped) {
    lines.push(`${labelForSource(source)}:`);
    for (const evidence of evidenceList) {
      lines.push(`- ${evidence.title}`);
      lines.push(`  ${clampSnippet(evidence.snippet, 240)}`);
    }
  }

  const rendered = lines.join("\n").trim();
  if (rendered.length <= maxChars) {
    return rendered;
  }
  return clampSnippet(rendered, maxChars);
}
