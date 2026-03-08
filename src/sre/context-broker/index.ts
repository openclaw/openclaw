import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { readRelationshipIndexLatestSnapshot } from "../../plugins/bundled/relationship-index/store.js";
import { loadRepoOwnershipMap } from "../repo-ownership/load.js";
import { resolveSreStatePaths } from "../state/paths.js";
import { classifyContextBrokerIntent, type ContextBrokerClassification } from "./classifier.js";
import { buildContextBrokerPrependContext, type ContextBrokerEvidence } from "./inject.js";

export type ContextBrokerInput = {
  config?: OpenClawConfig;
  prompt: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
};

export type ContextBrokerResult = ContextBrokerClassification & {
  prependContext?: string;
  evidence: ContextBrokerEvidence[];
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function tokenize(prompt: string): string[] {
  return unique(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9_.:/-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function scoreText(tokens: string[], haystack: string): number {
  const lowered = haystack.toLowerCase();
  return tokens.reduce((score, token) => score + (lowered.includes(token) ? 1 : 0), 0);
}

function resolveBrokerPaths(config: OpenClawConfig | undefined): {
  dossiersDir: string;
  repoOwnershipPath: string;
} {
  const fallback = resolveSreStatePaths(process.env);
  const dossiersDir = config?.sre?.stateRoots?.dossiersDir?.trim() || fallback.dossiersDir;
  const repoOwnershipPath =
    config?.sre?.repoOwnership?.filePath?.trim() ||
    path.join(fallback.indexDir, "repo-ownership.json");
  return { dossiersDir, repoOwnershipPath };
}

async function retrieveMemoryEvidence(input: ContextBrokerInput): Promise<ContextBrokerEvidence[]> {
  if (!input.config || !input.agentId) {
    return [];
  }
  const { manager } = await getMemorySearchManager({
    cfg: input.config,
    agentId: input.agentId,
  });
  if (!manager) {
    return [];
  }
  const results = await manager.search(input.prompt, {
    maxResults: 3,
    sessionKey: input.sessionKey,
  });
  return results.slice(0, 3).map((result, index) => ({
    source: "memory",
    title: result.path,
    snippet: result.snippet,
    score: Math.max(1, results.length - index),
  }));
}

async function retrieveDossierEvidence(
  input: ContextBrokerInput,
  dossiersDir: string,
): Promise<ContextBrokerEvidence[]> {
  const tokens = tokenize(input.prompt);
  let incidentDirs: string[] = [];
  try {
    incidentDirs = (await fs.readdir(dossiersDir)).slice(0, 50);
  } catch {
    return [];
  }

  const evidence: ContextBrokerEvidence[] = [];
  for (const incidentId of incidentDirs) {
    const summaryPath = path.join(dossiersDir, incidentId, "summary.md");
    try {
      const summary = await fs.readFile(summaryPath, "utf8");
      const score = scoreText(tokens, `${incidentId}\n${summary}`);
      if (score > 0) {
        evidence.push({
          source: "incident-dossier",
          title: incidentId,
          snippet: summary,
          score,
        });
      }
    } catch {
      continue;
    }
  }
  return evidence.toSorted((left, right) => right.score - left.score).slice(0, 3);
}

async function retrieveRelationshipEvidence(
  input: ContextBrokerInput,
): Promise<ContextBrokerEvidence[]> {
  const latest = await readRelationshipIndexLatestSnapshot(process.env).catch(() => undefined);
  if (!latest) {
    return [];
  }

  const tokens = tokenize(input.prompt);
  const evidence = Object.values(latest.nodes)
    .map((node) => {
      const haystack = `${node.entityId}\n${node.entityType}\n${JSON.stringify(node.attributes ?? {})}`;
      const score = scoreText(tokens, haystack);
      return score > 0
        ? {
            source: "relationship-index",
            title: node.entityId,
            snippet: haystack,
            score,
          }
        : null;
    })
    .filter((entry): entry is ContextBrokerEvidence => entry !== null)
    .toSorted((left, right) => right.score - left.score)
    .slice(0, 3);

  return evidence;
}

async function retrieveRepoOwnershipEvidence(
  input: ContextBrokerInput,
  repoOwnershipPath: string,
): Promise<ContextBrokerEvidence[]> {
  const tokens = tokenize(input.prompt);
  const map = await loadRepoOwnershipMap(repoOwnershipPath).catch(() => null);
  if (!map) {
    return [];
  }

  return map.repos
    .map((repo) => {
      const haystack = [
        repo.repoId,
        repo.githubRepo ?? "",
        repo.localPath,
        ...repo.sourceOfTruthDomains,
        ...repo.ownedGlobs,
      ].join("\n");
      const score = scoreText(tokens, haystack);
      return score > 0
        ? {
            source: "repo-ownership",
            title: repo.repoId,
            snippet: haystack,
            score,
          }
        : null;
    })
    .filter((entry): entry is ContextBrokerEvidence => entry !== null)
    .toSorted((left, right) => right.score - left.score)
    .slice(0, 3);
}

export async function runContextBroker(input: ContextBrokerInput): Promise<ContextBrokerResult> {
  if (input.config?.sre?.contextBroker?.enabled !== true) {
    return { intents: [], reasons: [], evidence: [] };
  }

  const classification = classifyContextBrokerIntent(input.prompt);
  if (classification.intents.length === 0) {
    return { ...classification, evidence: [] };
  }

  const { dossiersDir, repoOwnershipPath } = resolveBrokerPaths(input.config);
  const evidence = [
    ...(classification.intents.includes("prior-work")
      ? await retrieveMemoryEvidence(input).catch(() => [])
      : []),
    ...(classification.intents.includes("incident-follow-up")
      ? await retrieveDossierEvidence(input, dossiersDir).catch(() => [])
      : []),
    ...(classification.intents.some(
      (intent) =>
        intent === "incident-follow-up" ||
        intent === "repo-deploy-ownership" ||
        intent === "multi-repo-fix-planning",
    )
      ? await retrieveRelationshipEvidence(input).catch(() => [])
      : []),
    ...(classification.intents.some(
      (intent) => intent === "repo-deploy-ownership" || intent === "multi-repo-fix-planning",
    )
      ? await retrieveRepoOwnershipEvidence(input, repoOwnershipPath).catch(() => [])
      : []),
  ]
    .toSorted((left, right) => right.score - left.score)
    .slice(0, 6);

  return {
    ...classification,
    evidence,
    prependContext: buildContextBrokerPrependContext({
      intents: classification.intents,
      evidence,
    }),
  };
}
