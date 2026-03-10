import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { getMemorySearchManager } from "../../memory/index.js";
import {
  readRelationshipIndexLatestSnapshot,
  resolveRelationshipIndexStorePaths,
  type RelationshipIndexNode,
} from "../../plugins/bundled/relationship-index/store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { RelationshipEdge } from "../contracts/entity.js";
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

type RelationshipGraphSnapshot = {
  nodes: Record<string, RelationshipIndexNode>;
  edges: RelationshipEdge[];
};

type ShellRelationshipNode = {
  id?: string;
  type?: string;
  name?: string;
  source?: string;
  [key: string]: unknown;
};

type ShellRelationshipEdge = {
  id?: string;
  source?: string;
  target?: string;
  type?: string;
  source_kind?: string;
  notes?: string;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRelationshipEdgeLine(line: string): RelationshipEdge | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.edgeId === "string" &&
      typeof parsed.from === "string" &&
      typeof parsed.to === "string" &&
      typeof parsed.edgeType === "string" &&
      Array.isArray(parsed.provenance)
    ) {
      return parsed as RelationshipEdge;
    }
  } catch {
    // ignore malformed lines; keep the rest of the graph available
  }
  return undefined;
}

function parseShellRelationshipNode(value: unknown): ShellRelationshipNode | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  if (!id && !name) {
    return undefined;
  }
  return value as ShellRelationshipNode;
}

function parseShellRelationshipEdge(value: unknown): ShellRelationshipEdge | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const source = typeof value.source === "string" ? value.source : undefined;
  const target = typeof value.target === "string" ? value.target : undefined;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (!source || !target || !type) {
    return undefined;
  }
  return value as ShellRelationshipEdge;
}

async function loadRelationshipGraphSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RelationshipGraphSnapshot> {
  const latest = await readRelationshipIndexLatestSnapshot(env);
  const edgesPath = resolveRelationshipIndexStorePaths(env).edgesPath;
  let edges: RelationshipEdge[] = [];
  try {
    const raw = await fs.readFile(edgesPath, "utf8");
    edges = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => parseRelationshipEdgeLine(line))
      .filter((edge): edge is RelationshipEdge => edge !== undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return {
    nodes: latest?.nodes ?? {},
    edges,
  };
}

async function loadShellRelationshipKnowledge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ nodes: ShellRelationshipNode[]; edges: ShellRelationshipEdge[] }> {
  const incidentStateDir = env.INCIDENT_STATE_DIR?.trim();
  if (!incidentStateDir) {
    return { nodes: [], edges: [] };
  }
  const cachePath = path.join(incidentStateDir, "relationship-knowledge-cache.json");
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
      nodes?: unknown;
      edges?: unknown;
    };
    return {
      nodes: Array.isArray(parsed.nodes)
        ? parsed.nodes
            .map((node) => parseShellRelationshipNode(node))
            .filter((node): node is ShellRelationshipNode => node !== undefined)
        : [],
      edges: Array.isArray(parsed.edges)
        ? parsed.edges
            .map((edge) => parseShellRelationshipEdge(edge))
            .filter((edge): edge is ShellRelationshipEdge => edge !== undefined)
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { nodes: [], edges: [] };
    }
    throw error;
  }
}

function describeRelationshipNode(node: RelationshipIndexNode | undefined): string {
  if (!node) {
    return "";
  }
  return `${node.entityId}\n${node.entityType}\n${JSON.stringify(node.attributes ?? {})}`;
}

function buildRelationshipNeighborEvidence(params: {
  graph: RelationshipGraphSnapshot;
  entityId: string;
  baseScore: number;
}): ContextBrokerEvidence[] {
  const neighbors: ContextBrokerEvidence[] = [];
  for (const edge of params.graph.edges) {
    let neighborId: string | undefined;
    let direction: "in" | "out" | undefined;
    if (edge.from === params.entityId) {
      neighborId = edge.to;
      direction = "out";
    } else if (edge.to === params.entityId) {
      neighborId = edge.from;
      direction = "in";
    }
    if (!neighborId || !direction) {
      continue;
    }
    const neighbor = params.graph.nodes[neighborId];
    const provenanceSource = edge.provenance[0]?.source ?? "unknown";
    neighbors.push({
      source: "relationship-index",
      title: `${params.entityId} ${direction === "out" ? "->" : "<-"} ${edge.edgeType} ${neighborId}`,
      snippet: [
        `edge_type=${edge.edgeType}`,
        `neighbor=${neighborId}`,
        neighbor ? `neighbor_type=${neighbor.entityType}` : undefined,
        `provenance=${provenanceSource}`,
        neighbor ? `neighbor_attrs=${JSON.stringify(neighbor.attributes ?? {})}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      // Score neighbors slightly below the matched entity so direct hits rank first.
      score: Math.max(1, params.baseScore - 1),
    });
  }
  return neighbors;
}

function scoreShellItems<T>(params: {
  items: T[];
  tokens: string[];
  toHaystack: (item: T) => string;
  toTitle: (item: T) => string;
}): ContextBrokerEvidence[] {
  return params.items
    .map((item) => {
      const haystack = params.toHaystack(item);
      const score = scoreText(params.tokens, haystack);
      return score > 0
        ? {
            source: "relationship-knowledge",
            title: params.toTitle(item),
            snippet: haystack,
            score,
          }
        : null;
    })
    .filter((entry): entry is ContextBrokerEvidence => entry !== null)
    .slice(0, 3);
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

function resolveContextBrokerAgentId(input: ContextBrokerInput): string {
  const explicit = input.agentId?.trim();
  if (explicit) {
    return normalizeAgentId(explicit);
  }
  const parsed = parseAgentSessionKey(input.sessionKey);
  return normalizeAgentId(parsed?.agentId);
}

function canUseSreContextBroker(input: ContextBrokerInput): boolean {
  if (input.config?.sre?.contextBroker?.enabled !== true) {
    return false;
  }
  return resolveContextBrokerAgentId(input).startsWith("sre");
}

async function retrieveMemoryEvidence(input: ContextBrokerInput): Promise<ContextBrokerEvidence[]> {
  if (!input.config) {
    return [];
  }
  const agentId = resolveContextBrokerAgentId(input);
  const { manager } = await getMemorySearchManager({
    cfg: input.config,
    agentId,
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
  const graph = await loadRelationshipGraphSnapshot(process.env);
  const shellKnowledge = await loadShellRelationshipKnowledge(process.env);

  const tokens = tokenize(input.prompt);
  const nodeMatches = Object.values(graph?.nodes ?? {})
    .map((node) => {
      const haystack = describeRelationshipNode(node);
      const score = scoreText(tokens, haystack);
      return score > 0
        ? {
            source: "relationship-index",
            title: node.entityId,
            snippet: haystack,
            score,
            entityId: node.entityId,
          }
        : null;
    })
    .filter(
      (
        entry,
      ): entry is ContextBrokerEvidence & {
        entityId: string;
      } => entry !== null,
    )
    .toSorted((left, right) => right.score - left.score)
    .slice(0, 3);

  const neighborEvidence = graph
    ? nodeMatches.flatMap((entry) =>
        buildRelationshipNeighborEvidence({
          graph,
          entityId: entry.entityId,
          baseScore: entry.score,
        }),
      )
    : [];

  const shellNodeEvidence = scoreShellItems({
    items: shellKnowledge?.nodes ?? [],
    tokens,
    toHaystack: (node) =>
      [node.id, node.type, node.name, JSON.stringify(node)].filter(Boolean).join("\n"),
    toTitle: (node) => String(node.id ?? node.name ?? "shell-node"),
  });

  const shellEdgeEvidence = scoreShellItems({
    items: shellKnowledge?.edges ?? [],
    tokens,
    toHaystack: (edge) =>
      [edge.source, edge.type, edge.target, edge.notes, JSON.stringify(edge)]
        .filter(Boolean)
        .join("\n"),
    toTitle: (edge) =>
      `${String(edge.source ?? "unknown")} ${String(edge.type ?? "references")} ${String(edge.target ?? "unknown")}`,
  });

  return [...nodeMatches, ...neighborEvidence, ...shellNodeEvidence, ...shellEdgeEvidence]
    .map(({ source, title, snippet, score }) => ({ source, title, snippet, score }))
    .toSorted((left, right) => right.score - left.score)
    .slice(0, 6);
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
        ...(repo.impactedApps ?? []),
        ...(repo.deployments ?? []),
        ...(repo.charts ?? []),
        ...(repo.reviewers ?? []),
        repo.branchBase ?? "",
        repo.canaryStrategy ?? "",
        ...Object.entries(repo.validationProfiles ?? {}).flatMap(([profile, commands]) => [
          profile,
          ...commands,
        ]),
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
  if (!canUseSreContextBroker(input)) {
    return { intents: [], reasons: [], evidence: [] };
  }

  const classification = classifyContextBrokerIntent(input.prompt);
  if (classification.intents.length === 0) {
    return { ...classification, evidence: [] };
  }

  const { dossiersDir, repoOwnershipPath } = resolveBrokerPaths(input.config);
  const evidence = [
    ...(classification.intents.includes("prior-work") ? await retrieveMemoryEvidence(input) : []),
    ...(classification.intents.includes("incident-follow-up") &&
    input.config?.sre?.incidentDossier?.enabled === true
      ? await retrieveDossierEvidence(input, dossiersDir)
      : []),
    ...(classification.intents.some(
      (intent) =>
        intent === "incident-follow-up" ||
        intent === "repo-deploy-ownership" ||
        intent === "multi-repo-fix-planning",
    ) && input.config?.sre?.relationshipIndex?.enabled === true
      ? await retrieveRelationshipEvidence(input)
      : []),
    ...(classification.intents.some(
      (intent) => intent === "repo-deploy-ownership" || intent === "multi-repo-fix-planning",
    ) && input.config?.sre?.repoOwnership?.enabled === true
      ? await retrieveRepoOwnershipEvidence(input, repoOwnershipPath)
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
