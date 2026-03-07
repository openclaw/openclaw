import { randomUUID } from "node:crypto";
import path from "node:path";
import { compileGlobPattern } from "../agents/glob-pattern.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export type KnowledgeTransferMode = "ask" | "auto";
export type KnowledgeTransferSide = "export" | "import";
export type KnowledgeTransferRuleDecision = "hide" | KnowledgeTransferMode;

export type KnowledgeTransferRule = {
  id: string;
  side: KnowledgeTransferSide;
  pathPattern: string;
  decision: KnowledgeTransferRuleDecision;
  updatedAtMs: number;
};

export type KnowledgeTransferPairPolicy = {
  updatedAtMs: number;
  rules: KnowledgeTransferRule[];
};

export type KnowledgeTransferPolicyStore = {
  version: 2;
  updatedAtMs: number;
  pairs: Record<string, KnowledgeTransferPairPolicy>;
};

export type KnowledgeTransferDefaults = {
  enabled: boolean;
  defaultMode: KnowledgeTransferMode;
  defaultExportMode: KnowledgeTransferMode;
  defaultImportMode: KnowledgeTransferMode;
  approvalTimeoutSeconds: number;
};

export type KnowledgeTransferModeResolution = {
  mode: KnowledgeTransferMode;
  source: "pair" | "requester_wildcard" | "target_wildcard" | "global_wildcard" | "default";
  matchedPair?: { requesterAgentId: string; targetAgentId: string };
  defaults: KnowledgeTransferDefaults;
};

export type KnowledgeTransferPathResolution = {
  allowed: boolean;
  decision: KnowledgeTransferRuleDecision;
  mode?: KnowledgeTransferMode;
  side: KnowledgeTransferSide;
  source: "pair" | "requester_wildcard" | "target_wildcard" | "global_wildcard" | "default_deny";
  matchedPair?: { requesterAgentId: string; targetAgentId: string };
  matchedRuleId?: string;
  matchedPathPattern?: string;
};

export type KnowledgeTransferPolicyRuleView = {
  requesterAgentId: string;
  targetAgentId: string;
  id: string;
  side: KnowledgeTransferSide;
  pathPattern: string;
  decision: KnowledgeTransferRuleDecision;
  updatedAtMs: number;
};

type RuleMatch = {
  source: Exclude<KnowledgeTransferPathResolution["source"], "default_deny">;
  matchedPair: { requesterAgentId: string; targetAgentId: string };
  rule: KnowledgeTransferRule;
};

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 120;
const MIN_APPROVAL_TIMEOUT_SECONDS = 1;
const MAX_APPROVAL_TIMEOUT_SECONDS = 60 * 60;
const withLock = createAsyncLock();

function resolvePath(baseDir?: string): string {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "knowledge-transfer-policy.json");
}

function normalizeMode(value: unknown): KnowledgeTransferMode | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "ask" || normalized === "auto") {
    return normalized;
  }
  return undefined;
}

function normalizeSide(value: unknown): KnowledgeTransferSide | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "export" || normalized === "import") {
    return normalized;
  }
  return undefined;
}

function normalizeDecision(value: unknown): KnowledgeTransferRuleDecision | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "ask" || normalized === "auto" || normalized === "hide") {
    return normalized;
  }
  if (normalized === "deny") {
    return "hide";
  }
  if (normalized === "allow") {
    return "auto";
  }
  return undefined;
}

function normalizePathPattern(raw: unknown): string {
  const normalized =
    typeof raw === "string"
      ? raw
          .trim()
          .replace(/\\/g, "/")
          .replace(/^[./]+/, "")
          .toLowerCase()
      : "";
  if (!normalized) {
    return "*";
  }
  return normalized;
}

function normalizeMemoryPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[./]+/, "")
    .toLowerCase();
}

function clampApprovalTimeoutSeconds(value: unknown): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
  if (typeof numeric !== "number") {
    return DEFAULT_APPROVAL_TIMEOUT_SECONDS;
  }
  return Math.max(MIN_APPROVAL_TIMEOUT_SECONDS, Math.min(MAX_APPROVAL_TIMEOUT_SECONDS, numeric));
}

function normalizePairAgentId(raw: unknown, opts?: { allowWildcard?: boolean }): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (opts?.allowWildcard && trimmed === "*") {
    return "*";
  }
  return normalizeAgentId(trimmed || "main");
}

export function buildKnowledgeTransferPairKey(
  requesterAgentId: string,
  targetAgentId: string,
): string {
  const requester = normalizePairAgentId(requesterAgentId, { allowWildcard: true });
  const target = normalizePairAgentId(targetAgentId, { allowWildcard: true });
  return `${requester}|${target}`;
}

function splitPairKey(pairKey: string): { requesterAgentId: string; targetAgentId: string } | null {
  const [requesterAgentId, targetAgentId] = pairKey.split("|");
  if (!requesterAgentId || !targetAgentId) {
    return null;
  }
  return { requesterAgentId, targetAgentId };
}

function resolvePairCandidates(
  requesterAgentId: string,
  targetAgentId: string,
): Array<{
  key: string;
  source: Exclude<KnowledgeTransferPathResolution["source"], "default_deny">;
  matchedPair: { requesterAgentId: string; targetAgentId: string };
}> {
  return [
    {
      key: buildKnowledgeTransferPairKey(requesterAgentId, targetAgentId),
      source: "pair",
      matchedPair: { requesterAgentId, targetAgentId },
    },
    {
      key: buildKnowledgeTransferPairKey(requesterAgentId, "*"),
      source: "requester_wildcard",
      matchedPair: { requesterAgentId, targetAgentId: "*" },
    },
    {
      key: buildKnowledgeTransferPairKey("*", targetAgentId),
      source: "target_wildcard",
      matchedPair: { requesterAgentId: "*", targetAgentId },
    },
    {
      key: buildKnowledgeTransferPairKey("*", "*"),
      source: "global_wildcard",
      matchedPair: { requesterAgentId: "*", targetAgentId: "*" },
    },
  ];
}

function buildDefaultStore(): KnowledgeTransferPolicyStore {
  return {
    version: 2,
    updatedAtMs: 0,
    pairs: {},
  };
}

function sanitizeRule(raw: unknown): KnowledgeTransferRule | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as {
    id?: unknown;
    side?: unknown;
    pathPattern?: unknown;
    decision?: unknown;
    mode?: unknown;
    updatedAtMs?: unknown;
  };
  const side = normalizeSide(record.side);
  if (!side) {
    return null;
  }
  const decision = normalizeDecision(record.decision ?? record.mode);
  if (!decision) {
    return null;
  }
  const idRaw = typeof record.id === "string" ? record.id.trim() : "";
  const id = idRaw || randomUUID();
  const pathPattern = normalizePathPattern(record.pathPattern ?? "*");
  const updatedAtMs =
    typeof record.updatedAtMs === "number" && record.updatedAtMs > 0 ? record.updatedAtMs : 0;
  return { id, side, pathPattern, decision, updatedAtMs };
}

function buildLegacyPairRules(params: {
  mode: KnowledgeTransferMode;
  pairKey: string;
  updatedAtMs: number;
}): KnowledgeTransferRule[] {
  return [
    {
      id: `${params.pairKey}:legacy:export`,
      side: "export",
      pathPattern: "*",
      decision: params.mode,
      updatedAtMs: params.updatedAtMs,
    },
    {
      id: `${params.pairKey}:legacy:import`,
      side: "import",
      pathPattern: "*",
      decision: params.mode,
      updatedAtMs: params.updatedAtMs,
    },
  ];
}

function sanitizeStore(raw: unknown): KnowledgeTransferPolicyStore {
  if (!raw || typeof raw !== "object") {
    return buildDefaultStore();
  }
  const record = raw as {
    version?: unknown;
    updatedAtMs?: unknown;
    pairs?: unknown;
  };

  const pairsRaw =
    record.pairs && typeof record.pairs === "object"
      ? (record.pairs as Record<string, unknown>)
      : {};
  const pairs: Record<string, KnowledgeTransferPairPolicy> = {};

  for (const [pairKey, pairRaw] of Object.entries(pairsRaw)) {
    const pair = splitPairKey(pairKey);
    if (!pair) {
      continue;
    }

    const pairRecord = pairRaw && typeof pairRaw === "object" ? pairRaw : {};
    const pairObj = pairRecord as {
      updatedAtMs?: unknown;
      rules?: unknown;
      mode?: unknown;
    };
    const pairUpdatedAtMs =
      typeof pairObj.updatedAtMs === "number" && pairObj.updatedAtMs > 0 ? pairObj.updatedAtMs : 0;

    if (Array.isArray(pairObj.rules)) {
      const rules = pairObj.rules
        .map((entry) => sanitizeRule(entry))
        .filter((entry): entry is KnowledgeTransferRule => entry !== null);
      pairs[pairKey] = {
        updatedAtMs: pairUpdatedAtMs,
        rules,
      };
      continue;
    }

    const legacyMode = normalizeMode(pairObj.mode);
    if (!legacyMode) {
      pairs[pairKey] = {
        updatedAtMs: pairUpdatedAtMs,
        rules: [],
      };
      continue;
    }

    pairs[pairKey] = {
      updatedAtMs: pairUpdatedAtMs,
      rules: buildLegacyPairRules({
        mode: legacyMode,
        pairKey,
        updatedAtMs: pairUpdatedAtMs,
      }),
    };
  }

  return {
    version: 2,
    updatedAtMs:
      typeof record.updatedAtMs === "number" && record.updatedAtMs > 0 ? record.updatedAtMs : 0,
    pairs,
  };
}

export function resolveKnowledgeTransferDefaults(cfg: OpenClawConfig): KnowledgeTransferDefaults {
  const raw = cfg.tools?.agentToAgent?.knowledgeTransfer;
  const legacyMode = normalizeMode(raw?.defaultMode);
  const defaultExportMode = normalizeMode(raw?.defaultExportMode) ?? legacyMode ?? "ask";
  const defaultImportMode = normalizeMode(raw?.defaultImportMode) ?? legacyMode ?? "ask";
  return {
    enabled: raw?.enabled === true,
    defaultMode: legacyMode ?? "ask",
    defaultExportMode,
    defaultImportMode,
    approvalTimeoutSeconds: clampApprovalTimeoutSeconds(raw?.approvalTimeoutSeconds),
  };
}

export async function loadKnowledgeTransferPolicyStore(
  baseDir?: string,
): Promise<KnowledgeTransferPolicyStore> {
  const filePath = resolvePath(baseDir);
  const existing = await readJsonFile<KnowledgeTransferPolicyStore>(filePath);
  return sanitizeStore(existing);
}

function findRuleMatch(params: {
  store: KnowledgeTransferPolicyStore;
  requesterAgentId: string;
  targetAgentId: string;
  side: KnowledgeTransferSide;
  sourcePath: string;
}): RuleMatch | null {
  const sourcePath = normalizeMemoryPath(params.sourcePath);
  const candidates = resolvePairCandidates(params.requesterAgentId, params.targetAgentId);

  for (const candidate of candidates) {
    const pair = params.store.pairs[candidate.key];
    if (!pair || pair.rules.length === 0) {
      continue;
    }

    let matchedRule: KnowledgeTransferRule | null = null;
    for (const rule of pair.rules) {
      if (rule.side !== params.side) {
        continue;
      }
      const pattern = compileGlobPattern({
        raw: rule.pathPattern,
        normalize: (value) => normalizePathPattern(value),
      });
      if (pattern.kind === "all") {
        matchedRule = rule;
        continue;
      }
      if (pattern.kind === "exact" && sourcePath === pattern.value) {
        matchedRule = rule;
        continue;
      }
      if (pattern.kind === "regex" && pattern.value.test(sourcePath)) {
        matchedRule = rule;
      }
    }

    if (matchedRule) {
      return {
        source: candidate.source,
        matchedPair: candidate.matchedPair,
        rule: matchedRule,
      };
    }
  }

  return null;
}

function resolvePathDecisionFromStore(params: {
  store: KnowledgeTransferPolicyStore;
  requesterAgentId: string;
  targetAgentId: string;
  side: KnowledgeTransferSide;
  sourcePath: string;
}): KnowledgeTransferPathResolution {
  const match = findRuleMatch(params);
  if (!match) {
    return {
      allowed: false,
      decision: "hide",
      side: params.side,
      source: "default_deny",
    };
  }

  if (match.rule.decision === "hide") {
    return {
      allowed: false,
      decision: "hide",
      side: params.side,
      source: match.source,
      matchedPair: match.matchedPair,
      matchedRuleId: match.rule.id,
      matchedPathPattern: match.rule.pathPattern,
    };
  }

  return {
    allowed: true,
    decision: match.rule.decision,
    mode: match.rule.decision,
    side: params.side,
    source: match.source,
    matchedPair: match.matchedPair,
    matchedRuleId: match.rule.id,
    matchedPathPattern: match.rule.pathPattern,
  };
}

export async function resolveKnowledgeTransferPathDecision(params: {
  requesterAgentId: string;
  targetAgentId: string;
  side: KnowledgeTransferSide;
  sourcePath: string;
  baseDir?: string;
}): Promise<KnowledgeTransferPathResolution> {
  const store = await loadKnowledgeTransferPolicyStore(params.baseDir);
  return resolvePathDecisionFromStore({
    store,
    requesterAgentId: normalizePairAgentId(params.requesterAgentId),
    targetAgentId: normalizePairAgentId(params.targetAgentId),
    side: params.side,
    sourcePath: params.sourcePath,
  });
}

export async function createKnowledgeTransferPolicyResolver(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  targetAgentId: string;
  baseDir?: string;
}): Promise<{
  defaults: KnowledgeTransferDefaults;
  resolve: (side: KnowledgeTransferSide, sourcePath: string) => KnowledgeTransferPathResolution;
}> {
  const store = await loadKnowledgeTransferPolicyStore(params.baseDir);
  const requesterAgentId = normalizePairAgentId(params.requesterAgentId);
  const targetAgentId = normalizePairAgentId(params.targetAgentId);
  const defaults = resolveKnowledgeTransferDefaults(params.cfg);
  return {
    defaults,
    resolve: (side, sourcePath) =>
      resolvePathDecisionFromStore({
        store,
        requesterAgentId,
        targetAgentId,
        side,
        sourcePath,
      }),
  };
}

export async function listKnowledgeTransferRules(params?: {
  requesterAgentId?: string;
  targetAgentId?: string;
  baseDir?: string;
}): Promise<KnowledgeTransferPolicyRuleView[]> {
  const store = await loadKnowledgeTransferPolicyStore(params?.baseDir);
  const filterPairKey =
    params?.requesterAgentId && params?.targetAgentId
      ? buildKnowledgeTransferPairKey(params.requesterAgentId, params.targetAgentId)
      : null;

  const views: KnowledgeTransferPolicyRuleView[] = [];
  for (const [pairKey, pairPolicy] of Object.entries(store.pairs)) {
    if (filterPairKey && pairKey !== filterPairKey) {
      continue;
    }
    const pair = splitPairKey(pairKey);
    if (!pair) {
      continue;
    }
    for (const rule of pairPolicy.rules) {
      views.push({
        requesterAgentId: pair.requesterAgentId,
        targetAgentId: pair.targetAgentId,
        id: rule.id,
        side: rule.side,
        pathPattern: rule.pathPattern,
        decision: rule.decision,
        updatedAtMs: rule.updatedAtMs,
      });
    }
  }

  views.sort((a, b) => {
    const pairA = `${a.requesterAgentId}|${a.targetAgentId}`;
    const pairB = `${b.requesterAgentId}|${b.targetAgentId}`;
    if (pairA !== pairB) {
      return pairA.localeCompare(pairB);
    }
    if (a.side !== b.side) {
      return a.side.localeCompare(b.side);
    }
    if (a.pathPattern !== b.pathPattern) {
      return a.pathPattern.localeCompare(b.pathPattern);
    }
    return a.updatedAtMs - b.updatedAtMs;
  });

  return views;
}

export async function upsertKnowledgeTransferRule(params: {
  requesterAgentId: string;
  targetAgentId: string;
  side: KnowledgeTransferSide;
  pathPattern: string;
  decision: KnowledgeTransferRuleDecision;
  id?: string;
  baseDir?: string;
}): Promise<{ store: KnowledgeTransferPolicyStore; rule: KnowledgeTransferRule }> {
  const filePath = resolvePath(params.baseDir);
  return await withLock(async () => {
    const store = sanitizeStore(await readJsonFile<KnowledgeTransferPolicyStore>(filePath));
    const now = Date.now();
    const pairKey = buildKnowledgeTransferPairKey(params.requesterAgentId, params.targetAgentId);
    const pairPolicy = store.pairs[pairKey] ?? { updatedAtMs: 0, rules: [] };

    const ruleId =
      typeof params.id === "string" && params.id.trim() ? params.id.trim() : randomUUID();
    const normalizedRule: KnowledgeTransferRule = {
      id: ruleId,
      side: params.side,
      pathPattern: normalizePathPattern(params.pathPattern),
      decision: params.decision,
      updatedAtMs: now,
    };

    const existingIndex = pairPolicy.rules.findIndex((rule) => rule.id === ruleId);
    if (existingIndex >= 0) {
      pairPolicy.rules[existingIndex] = normalizedRule;
    } else {
      pairPolicy.rules.push(normalizedRule);
    }

    pairPolicy.updatedAtMs = now;
    store.pairs[pairKey] = pairPolicy;
    store.updatedAtMs = now;
    await writeJsonAtomic(filePath, store, { trailingNewline: true });

    return { store, rule: normalizedRule };
  });
}

export async function removeKnowledgeTransferRule(params: {
  id: string;
  requesterAgentId?: string;
  targetAgentId?: string;
  baseDir?: string;
}): Promise<{ removed: boolean; pair?: { requesterAgentId: string; targetAgentId: string } }> {
  const id = params.id.trim();
  if (!id) {
    return { removed: false };
  }

  const filePath = resolvePath(params.baseDir);
  return await withLock(async () => {
    const store = sanitizeStore(await readJsonFile<KnowledgeTransferPolicyStore>(filePath));

    const targetPairKey =
      params.requesterAgentId && params.targetAgentId
        ? buildKnowledgeTransferPairKey(params.requesterAgentId, params.targetAgentId)
        : null;

    for (const [pairKey, pairPolicy] of Object.entries(store.pairs)) {
      if (targetPairKey && pairKey !== targetPairKey) {
        continue;
      }
      const index = pairPolicy.rules.findIndex((rule) => rule.id === id);
      if (index < 0) {
        continue;
      }

      pairPolicy.rules.splice(index, 1);
      const now = Date.now();
      pairPolicy.updatedAtMs = now;
      store.updatedAtMs = now;

      if (pairPolicy.rules.length === 0) {
        delete store.pairs[pairKey];
      } else {
        store.pairs[pairKey] = pairPolicy;
      }

      await writeJsonAtomic(filePath, store, { trailingNewline: true });
      const pair = splitPairKey(pairKey);
      return {
        removed: true,
        ...(pair ? { pair } : {}),
      };
    }

    return { removed: false };
  });
}

export async function listKnowledgeTransferPairPolicies(params?: {
  baseDir?: string;
}): Promise<
  Array<{ requesterAgentId: string; targetAgentId: string; mode: KnowledgeTransferMode }>
> {
  const store = await loadKnowledgeTransferPolicyStore(params?.baseDir);
  const entries: Array<{
    requesterAgentId: string;
    targetAgentId: string;
    mode: KnowledgeTransferMode;
  }> = [];

  for (const pairKey of Object.keys(store.pairs)) {
    const pair = splitPairKey(pairKey);
    if (!pair) {
      continue;
    }
    const match = findRuleMatch({
      store,
      requesterAgentId: pair.requesterAgentId,
      targetAgentId: pair.targetAgentId,
      side: "export",
      sourcePath: "*",
    });
    const mode =
      match?.rule.decision === "ask" || match?.rule.decision === "auto"
        ? match.rule.decision
        : "ask";
    entries.push({
      requesterAgentId: pair.requesterAgentId,
      targetAgentId: pair.targetAgentId,
      mode,
    });
  }

  entries.sort((a, b) =>
    `${a.requesterAgentId}|${a.targetAgentId}`.localeCompare(
      `${b.requesterAgentId}|${b.targetAgentId}`,
    ),
  );
  return entries;
}

export async function setKnowledgeTransferPairMode(params: {
  requesterAgentId: string;
  targetAgentId: string;
  mode: KnowledgeTransferMode;
  baseDir?: string;
}): Promise<KnowledgeTransferPolicyStore> {
  const filePath = resolvePath(params.baseDir);
  return await withLock(async () => {
    const store = sanitizeStore(await readJsonFile<KnowledgeTransferPolicyStore>(filePath));
    const now = Date.now();
    const pairKey = buildKnowledgeTransferPairKey(params.requesterAgentId, params.targetAgentId);
    const pairPolicy = store.pairs[pairKey] ?? { updatedAtMs: 0, rules: [] };

    pairPolicy.rules = pairPolicy.rules.filter(
      (rule) => !(rule.pathPattern === "*" && (rule.side === "export" || rule.side === "import")),
    );

    pairPolicy.rules.push(
      {
        id: randomUUID(),
        side: "export",
        pathPattern: "*",
        decision: params.mode,
        updatedAtMs: now,
      },
      {
        id: randomUUID(),
        side: "import",
        pathPattern: "*",
        decision: params.mode,
        updatedAtMs: now,
      },
    );

    pairPolicy.updatedAtMs = now;
    store.pairs[pairKey] = pairPolicy;
    store.updatedAtMs = now;
    await writeJsonAtomic(filePath, store, { trailingNewline: true });
    return store;
  });
}

export async function resolveKnowledgeTransferMode(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  targetAgentId: string;
  baseDir?: string;
}): Promise<KnowledgeTransferModeResolution> {
  const store = await loadKnowledgeTransferPolicyStore(params.baseDir);
  const requesterAgentId = normalizePairAgentId(params.requesterAgentId);
  const targetAgentId = normalizePairAgentId(params.targetAgentId);
  const defaults = resolveKnowledgeTransferDefaults(params.cfg);

  const match = findRuleMatch({
    store,
    requesterAgentId,
    targetAgentId,
    side: "export",
    sourcePath: "*",
  });
  if (match && (match.rule.decision === "ask" || match.rule.decision === "auto")) {
    return {
      mode: match.rule.decision,
      source: match.source,
      matchedPair: match.matchedPair,
      defaults,
    };
  }

  return {
    mode: defaults.defaultMode,
    source: "default",
    defaults,
  };
}
