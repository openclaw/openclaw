import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadJsonFile } from "../infra/json-file.js";
import {
  inferAgentIdFromAgentPath,
  normalizeMemoryDocumentPath,
  normalizePersistencePathKey,
} from "./path-keys.js";
import {
  getPostgresPersistenceWithMode,
  type PostgresPersistenceClient,
} from "./postgres-client.js";
import {
  persistAuthProfileStoreToPostgres,
  persistSessionStoreSnapshot,
  persistSubagentRegistryToPostgres,
  syncMemoryDocumentToPostgres,
  syncTranscriptFileToPostgres,
} from "./service.js";

export type DiscoveredPersistenceArtifacts = {
  sessionStores: string[];
  transcripts: string[];
  authStores: string[];
  subagentRegistryPath?: string;
  memoryDocuments: Array<{
    workspaceRoot: string;
    absolutePath: string;
    logicalPath: string;
    agentId?: string;
  }>;
};

export type StorageMigrationSummary = {
  dryRun: boolean;
  sessionStores: number;
  sessions: number;
  transcripts: number;
  transcriptEvents: number;
  authStores: number;
  subagentRuns: number;
  memoryDocuments: number;
};

export type StorageVerificationSummary = {
  discovered: StorageMigrationSummary;
  postgres: {
    sessions: number;
    sessionEvents: number;
    authProfiles: number;
    authSecrets: number;
    subagentRuns: number;
    memoryDocuments: number;
  };
  matches: boolean;
  mismatches: Array<{
    kind: "sessionStore" | "transcript" | "authStore" | "subagentRun" | "memoryDocument";
    key: string;
    expected: number;
    actual: number;
  }>;
};

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await fs.access(pathname);
    return true;
  } catch {
    return false;
  }
}

async function listImmediateDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function listFilesWithExtension(root: string, extension: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function walkMemoryDocs(
  workspaceRoot: string,
  folder: string,
): Promise<DiscoveredPersistenceArtifacts["memoryDocuments"]> {
  const documents: DiscoveredPersistenceArtifacts["memoryDocuments"] = [];
  const queue = [folder];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const logicalPath = normalizeMemoryDocumentPath(
        path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/"),
      );
      if (!logicalPath) {
        continue;
      }
      documents.push({
        workspaceRoot,
        absolutePath,
        logicalPath,
      });
    }
  }
  return documents;
}

function loadCurrentConfigSafe(): OpenClawConfig {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

function countTranscriptEvents(transcriptPath: string): Promise<number> {
  return fs
    .readFile(transcriptPath, "utf8")
    .then((raw) => raw.split("\n").filter((line) => line.trim()).length)
    .catch(() => 0);
}

function coerceSessionStore(
  raw: unknown,
): Record<string, { sessionId: string; updatedAt?: number }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, { sessionId: string; updatedAt?: number }> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const typed = value as { sessionId?: unknown; updatedAt?: unknown };
    if (typeof typed.sessionId !== "string" || !typed.sessionId.trim()) {
      continue;
    }
    out[key] = {
      sessionId: typed.sessionId,
      updatedAt: typeof typed.updatedAt === "number" ? typed.updatedAt : undefined,
    };
  }
  return out;
}

function coerceAuthStore(raw: unknown): AuthProfileStore | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!record.profiles || typeof record.profiles !== "object" || Array.isArray(record.profiles)) {
    return null;
  }
  return {
    version: Number(record.version ?? 1),
    profiles: record.profiles as AuthProfileStore["profiles"],
    order: (record.order as AuthProfileStore["order"]) ?? undefined,
    lastGood: (record.lastGood as AuthProfileStore["lastGood"]) ?? undefined,
    usageStats: (record.usageStats as AuthProfileStore["usageStats"]) ?? undefined,
  };
}

function coerceSubagentRuns(raw: unknown): Map<string, SubagentRunRecord> {
  const runs = new Map<string, SubagentRunRecord>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return runs;
  }
  const record = raw as { runs?: unknown };
  if (!record.runs || typeof record.runs !== "object" || Array.isArray(record.runs)) {
    return runs;
  }
  for (const [runId, value] of Object.entries(record.runs as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    runs.set(runId, value as SubagentRunRecord);
  }
  return runs;
}

export async function discoverPersistenceArtifacts(
  cfg: OpenClawConfig = loadCurrentConfigSafe(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveredPersistenceArtifacts> {
  const stateDir = resolveStateDir(env);
  const agentsDir = path.join(stateDir, "agents");
  const agentRoots = await listImmediateDirs(agentsDir);
  const sessionStores: string[] = [];
  const transcripts: string[] = [];
  const authStores: string[] = [];

  for (const agentRoot of agentRoots) {
    const sessionsDir = path.join(agentRoot, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    if (await fileExists(storePath)) {
      sessionStores.push(storePath);
    }
    const sessionFiles = await listFilesWithExtension(sessionsDir, ".jsonl");
    transcripts.push(...sessionFiles);

    const authPath = path.join(agentRoot, "agent", "auth-profiles.json");
    if (await fileExists(authPath)) {
      authStores.push(authPath);
    }
  }

  const defaultAuthPath = path.join(resolveOpenClawAgentDir(), "auth-profiles.json");
  if ((await fileExists(defaultAuthPath)) && !authStores.includes(defaultAuthPath)) {
    authStores.push(defaultAuthPath);
  }

  const subagentRegistryPath = path.join(stateDir, "subagents", "runs.json");
  const hasSubagentRegistry = await fileExists(subagentRegistryPath);

  const memoryDocuments: DiscoveredPersistenceArtifacts["memoryDocuments"] = [];
  const seenMemoryDocumentKeys = new Set<string>();
  for (const agentId of listAgentIds(cfg)) {
    const workspaceRoot = resolveAgentWorkspaceDir(cfg, agentId);
    if (!workspaceRoot) {
      continue;
    }
    const resolvedWorkspace = normalizePersistencePathKey(workspaceRoot);
    for (const logicalPath of ["MEMORY.md", "memory.md"]) {
      const absolutePath = path.join(resolvedWorkspace, logicalPath);
      if (await fileExists(absolutePath)) {
        const normalized = normalizeMemoryDocumentPath(logicalPath);
        if (normalized) {
          const key = `${resolvedWorkspace}\0${normalized.toLowerCase()}`;
          if (!seenMemoryDocumentKeys.has(key)) {
            seenMemoryDocumentKeys.add(key);
            memoryDocuments.push({
              workspaceRoot: resolvedWorkspace,
              absolutePath,
              logicalPath: normalized,
              agentId,
            });
          }
        }
      }
    }
    for (const entry of await walkMemoryDocs(
      resolvedWorkspace,
      path.join(resolvedWorkspace, "memory"),
    )) {
      const key = `${resolvedWorkspace}\0${entry.logicalPath.toLowerCase()}`;
      if (seenMemoryDocumentKeys.has(key)) {
        continue;
      }
      seenMemoryDocumentKeys.add(key);
      memoryDocuments.push({
        ...entry,
        agentId,
      });
    }
  }

  return {
    sessionStores: [...new Set(sessionStores)].toSorted(),
    transcripts: [...new Set(transcripts)].toSorted(),
    authStores: [...new Set(authStores)].toSorted(),
    subagentRegistryPath: hasSubagentRegistry ? subagentRegistryPath : undefined,
    memoryDocuments,
  };
}

export async function migratePersistenceToPostgres(params?: {
  dryRun?: boolean;
  cfg?: OpenClawConfig;
}): Promise<StorageMigrationSummary> {
  const artifacts = await discoverPersistenceArtifacts(params?.cfg);
  const client = params?.dryRun ? null : await getPostgresPersistenceWithMode("configured");
  if (!params?.dryRun && !client) {
    throw new Error("PostgreSQL persistence is not configured.");
  }
  const summary: StorageMigrationSummary = {
    dryRun: params?.dryRun === true,
    sessionStores: artifacts.sessionStores.length,
    sessions: 0,
    transcripts: artifacts.transcripts.length,
    transcriptEvents: 0,
    authStores: 0,
    subagentRuns: 0,
    memoryDocuments: artifacts.memoryDocuments.length,
  };

  for (const storePath of artifacts.sessionStores) {
    const rawStore = loadJsonFile(storePath);
    const store = coerceSessionStore(rawStore);
    summary.sessions += Object.keys(store).length;
    if (!params?.dryRun) {
      await persistSessionStoreSnapshot(
        {
          storePath,
          store:
            rawStore && typeof rawStore === "object" && !Array.isArray(rawStore)
              ? (rawStore as Record<string, SessionEntry>)
              : {},
        },
        { lookupMode: "configured" },
      );
    }
  }

  for (const transcriptPath of artifacts.transcripts) {
    summary.transcriptEvents += await countTranscriptEvents(transcriptPath);
    if (!params?.dryRun) {
      await syncTranscriptFileToPostgres(
        {
          transcriptPath,
          agentId: inferAgentIdFromAgentPath(transcriptPath),
        },
        { lookupMode: "configured" },
      );
    }
  }

  for (const authStorePath of artifacts.authStores) {
    const store = coerceAuthStore(loadJsonFile(authStorePath));
    if (!store) {
      continue;
    }
    summary.authStores += 1;
    if (!params?.dryRun) {
      await persistAuthProfileStoreToPostgres({
        store,
        agentDir: path.dirname(authStorePath),
      });
    }
  }

  if (artifacts.subagentRegistryPath) {
    const runs = coerceSubagentRuns(loadJsonFile(artifacts.subagentRegistryPath));
    summary.subagentRuns = runs.size;
    if (!params?.dryRun) {
      await persistSubagentRegistryToPostgres({ runs });
    }
  }

  for (const document of artifacts.memoryDocuments) {
    if (params?.dryRun) {
      continue;
    }
    const body = await fs.readFile(document.absolutePath, "utf8").catch(() => undefined);
    if (body === undefined) {
      continue;
    }
    await syncMemoryDocumentToPostgres({
      workspaceRoot: document.workspaceRoot,
      absolutePath: document.absolutePath,
      logicalPath: document.logicalPath,
      body,
      agentId: document.agentId,
    });
  }

  if (client) {
    const runId = crypto.randomUUID();
    await client.sql.unsafe(
      `
        insert into ${client.schemaSql}.import_runs
          (run_id, mode, dry_run, status, summary, finished_at)
        values ($1, $2, $3, $4, $5::jsonb, now())
      `,
      [runId, "migrate", false, "completed", JSON.stringify(summary)],
    );
  }

  return summary;
}

async function selectCount(client: PostgresPersistenceClient, table: string) {
  const rows = await client.sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from ${client.schemaSql}.${table}`,
  );
  return Number(rows[0]?.count ?? 0);
}

async function selectCountMap(
  client: PostgresPersistenceClient,
  query: string,
): Promise<Map<string, number>> {
  const rows = await client.sql.unsafe<Array<{ key: string; count: string }>>(query);
  return new Map(rows.map((row) => [row.key, Number(row.count ?? 0)]));
}

function addCountMismatch(params: {
  mismatches: StorageVerificationSummary["mismatches"];
  kind: StorageVerificationSummary["mismatches"][number]["kind"];
  key: string;
  expected: number;
  actual: number;
}) {
  if (params.expected === params.actual) {
    return;
  }
  params.mismatches.push({
    kind: params.kind,
    key: params.key,
    expected: params.expected,
    actual: params.actual,
  });
}

function addPresenceMismatch(params: {
  mismatches: StorageVerificationSummary["mismatches"];
  kind: StorageVerificationSummary["mismatches"][number]["kind"];
  key: string;
  expectedPresent: boolean;
  actualPresent: boolean;
}) {
  const expected = params.expectedPresent ? 1 : 0;
  const actual = params.actualPresent ? 1 : 0;
  if (expected === actual) {
    return;
  }
  params.mismatches.push({
    kind: params.kind,
    key: params.key,
    expected,
    actual,
  });
}

export async function verifyPostgresPersistence(
  cfg?: OpenClawConfig,
): Promise<StorageVerificationSummary> {
  const client = await getPostgresPersistenceWithMode("configured");
  if (!client) {
    throw new Error("PostgreSQL persistence is not configured.");
  }
  const artifacts = await discoverPersistenceArtifacts(cfg);
  const discoveredSummary = await migratePersistenceToPostgres({
    dryRun: true,
    cfg,
  });
  const sessionCounts = await selectCountMap(
    client,
    `select store_path as key, count(*)::text as count from ${client.schemaSql}.sessions group by store_path`,
  );
  const transcriptCounts = await selectCountMap(
    client,
    `select transcript_path as key, count(*)::text as count from ${client.schemaSql}.session_events group by transcript_path`,
  );
  const authRows = await client.sql.unsafe<Array<{ store_key: string }>>(
    `select store_key from ${client.schemaSql}.auth_profiles`,
  );
  const authStores = new Set(authRows.map((row) => row.store_key));
  const subagentRows = await client.sql.unsafe<Array<{ run_id: string }>>(
    `select run_id from ${client.schemaSql}.subagent_runs`,
  );
  const subagentRuns = new Set(subagentRows.map((row) => row.run_id));
  const memoryRows = await client.sql.unsafe<
    Array<{ workspace_root: string; logical_path: string }>
  >(`select workspace_root, logical_path from ${client.schemaSql}.memory_documents`);
  const memoryDocuments = new Set(
    memoryRows.map((row) => `${row.workspace_root}\0${row.logical_path.toLowerCase()}`),
  );

  const mismatches: StorageVerificationSummary["mismatches"] = [];
  for (const storePath of artifacts.sessionStores) {
    const normalized = normalizePersistencePathKey(storePath);
    const expected = Object.keys(coerceSessionStore(loadJsonFile(storePath))).length;
    const actual = sessionCounts.get(normalized) ?? 0;
    addCountMismatch({
      mismatches,
      kind: "sessionStore",
      key: normalized,
      expected,
      actual,
    });
  }
  for (const [key, actual] of sessionCounts.entries()) {
    if (
      artifacts.sessionStores.some((storePath) => normalizePersistencePathKey(storePath) === key)
    ) {
      continue;
    }
    addCountMismatch({
      mismatches,
      kind: "sessionStore",
      key,
      expected: 0,
      actual,
    });
  }

  for (const transcriptPath of artifacts.transcripts) {
    const normalized = normalizePersistencePathKey(transcriptPath);
    const expected = await countTranscriptEvents(transcriptPath);
    const actual = transcriptCounts.get(normalized) ?? 0;
    addCountMismatch({
      mismatches,
      kind: "transcript",
      key: normalized,
      expected,
      actual,
    });
  }
  for (const [key, actual] of transcriptCounts.entries()) {
    if (
      artifacts.transcripts.some(
        (transcriptPath) => normalizePersistencePathKey(transcriptPath) === key,
      )
    ) {
      continue;
    }
    addCountMismatch({
      mismatches,
      kind: "transcript",
      key,
      expected: 0,
      actual,
    });
  }

  for (const authStorePath of artifacts.authStores) {
    const normalized = normalizePersistencePathKey(authStorePath);
    const hasStore = coerceAuthStore(loadJsonFile(authStorePath)) !== null;
    addPresenceMismatch({
      mismatches,
      kind: "authStore",
      key: normalized,
      expectedPresent: hasStore,
      actualPresent: authStores.has(normalized),
    });
  }
  for (const key of authStores) {
    if (
      artifacts.authStores.some(
        (authStorePath) => normalizePersistencePathKey(authStorePath) === key,
      )
    ) {
      continue;
    }
    addPresenceMismatch({
      mismatches,
      kind: "authStore",
      key,
      expectedPresent: false,
      actualPresent: true,
    });
  }

  if (artifacts.subagentRegistryPath) {
    const expectedRuns = coerceSubagentRuns(loadJsonFile(artifacts.subagentRegistryPath));
    for (const runId of expectedRuns.keys()) {
      addPresenceMismatch({
        mismatches,
        kind: "subagentRun",
        key: runId,
        expectedPresent: true,
        actualPresent: subagentRuns.has(runId),
      });
    }
    for (const runId of subagentRuns) {
      if (expectedRuns.has(runId)) {
        continue;
      }
      addPresenceMismatch({
        mismatches,
        kind: "subagentRun",
        key: runId,
        expectedPresent: false,
        actualPresent: true,
      });
    }
  } else {
    for (const runId of subagentRuns) {
      addPresenceMismatch({
        mismatches,
        kind: "subagentRun",
        key: runId,
        expectedPresent: false,
        actualPresent: true,
      });
    }
  }

  const expectedMemoryDocuments = new Set(
    artifacts.memoryDocuments.map(
      (document) => `${document.workspaceRoot}\0${document.logicalPath.toLowerCase()}`,
    ),
  );
  for (const key of expectedMemoryDocuments) {
    addPresenceMismatch({
      mismatches,
      kind: "memoryDocument",
      key,
      expectedPresent: true,
      actualPresent: memoryDocuments.has(key),
    });
  }
  for (const key of memoryDocuments) {
    if (expectedMemoryDocuments.has(key)) {
      continue;
    }
    addPresenceMismatch({
      mismatches,
      kind: "memoryDocument",
      key,
      expectedPresent: false,
      actualPresent: true,
    });
  }

  return {
    discovered: discoveredSummary,
    postgres: {
      sessions: await selectCount(client, "sessions"),
      sessionEvents: await selectCount(client, "session_events"),
      authProfiles: await selectCount(client, "auth_profiles"),
      authSecrets: await selectCount(client, "auth_secrets"),
      subagentRuns: await selectCount(client, "subagent_runs"),
      memoryDocuments: await selectCount(client, "memory_documents"),
    },
    matches: mismatches.length === 0,
    mismatches,
  };
}
