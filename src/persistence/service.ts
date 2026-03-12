import fs from "node:fs/promises";
import path from "node:path";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { writeFileWithinRoot } from "../infra/fs-safe.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listMemoryFiles } from "../memory/internal.js";
import { decryptJsonValue, encryptJsonValue, type EncryptedJsonPayload } from "./crypto.js";
import {
  deriveSessionIdFromTranscriptPath,
  inferAgentIdFromAgentPath,
  normalizeMemoryDocumentPath,
  normalizePersistencePathKey,
  resolvePathRelativeToRoot,
} from "./path-keys.js";
import {
  getPostgresPersistenceForConfig,
  getPostgresPersistenceWithMode,
  isPostgresPersistenceEnabled,
  type PostgresPersistenceClient,
  type PostgresPersistenceLookupMode,
} from "./postgres-client.js";

const log = createSubsystemLogger("persistence");

type AuthSecretRecord = {
  profileId: string;
  value: Record<string, unknown>;
};

type PersistedAuthProfileMetadataStore = {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
  order?: AuthProfileStore["order"];
  lastGood?: AuthProfileStore["lastGood"];
  usageStats?: AuthProfileStore["usageStats"];
};

type TranscriptRow = {
  seq: number;
  entryType: string;
  parsed: Record<string, unknown>;
};

type PersistableSessionManager = Pick<
  SessionManager,
  "getEntries" | "getHeader" | "getSessionFile" | "getSessionId"
>;

const backgroundTasks = new Set<Promise<unknown>>();
const authStoreQueues = new Map<string, Promise<void>>();
const memoryDocumentQueues = new Map<string, Promise<void>>();
const registryQueues = new Map<string, Promise<void>>();
const transcriptQueues = new Map<string, Promise<void>>();

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trackBackgroundTask(task: Promise<unknown>): void {
  backgroundTasks.add(task);
  void task.finally(() => {
    backgroundTasks.delete(task);
  });
}

async function getPersistenceClient(options?: {
  lookupMode?: PostgresPersistenceLookupMode;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<PostgresPersistenceClient | null> {
  if (options?.config) {
    return await getPostgresPersistenceForConfig({
      config: options.config,
      env: options.env,
      mode: options.lookupMode ?? "runtime",
    });
  }
  return await getPostgresPersistenceWithMode(options?.lookupMode ?? "runtime");
}

async function requirePersistenceClient(options?: {
  lookupMode?: PostgresPersistenceLookupMode;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<PostgresPersistenceClient> {
  const lookupMode = options?.lookupMode ?? "runtime";
  const client = await getPersistenceClient(options);
  if (!client) {
    throw new Error(
      lookupMode === "runtime"
        ? "PostgreSQL persistence is not enabled."
        : "PostgreSQL persistence is not configured.",
    );
  }
  return client;
}

async function runSerializedByKey<T>(
  queueMap: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = queueMap.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const barrier = previous.catch(() => undefined).then(() => gate);
  queueMap.set(key, barrier);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (queueMap.get(key) === barrier) {
      queueMap.delete(key);
    }
  }
}

async function withTranscriptQueue<T>(transcriptPath: string, task: () => Promise<T>): Promise<T> {
  const normalizedPath = normalizePersistencePathKey(transcriptPath);
  return await runSerializedByKey(transcriptQueues, normalizedPath, task);
}

async function lockTranscript(
  tx: Pick<PostgresPersistenceClient["sql"], "unsafe">,
  transcriptPath: string,
) {
  await tx.unsafe("select pg_advisory_xact_lock(hashtext($1))", [transcriptPath]);
}

function resolveTranscriptSessionId(
  transcriptPath: string,
  rows: Array<{ parsed: Record<string, unknown> }>,
): string | undefined {
  for (const row of rows) {
    if (row.parsed.type !== "session") {
      continue;
    }
    const id = row.parsed.id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return deriveSessionIdFromTranscriptPath(transcriptPath);
}

function buildTranscriptRowsFromRaw(raw: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    rows.push({
      seq: index + 1,
      entryType: typeof record.type === "string" ? record.type : "unknown",
      parsed: record,
    });
  }
  return rows;
}

function buildTranscriptRowsFromSessionManager(
  sessionManager: PersistableSessionManager,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const header = sessionManager.getHeader();
  if (header) {
    rows.push({
      seq: 1,
      entryType: header.type,
      parsed: header as unknown as Record<string, unknown>,
    });
  }
  for (const [index, entry] of sessionManager.getEntries().entries()) {
    rows.push({
      seq: index + (header ? 2 : 1),
      entryType: entry.type,
      parsed: entry as unknown as Record<string, unknown>,
    });
  }
  return rows;
}

async function replaceTranscriptRows(params: {
  client: PostgresPersistenceClient;
  transcriptPath: string;
  sessionId: string;
  agentId?: string;
  rows: TranscriptRow[];
}): Promise<void> {
  await params.client.sql.begin(async (tx) => {
    await lockTranscript(tx, params.transcriptPath);
    await tx.unsafe(
      `delete from ${params.client.schemaSql}.session_events where transcript_path = $1`,
      [params.transcriptPath],
    );
    for (const row of params.rows) {
      await tx.unsafe(
        `
          insert into ${params.client.schemaSql}.session_events
            (transcript_path, agent_id, session_id, seq, entry_type, payload)
          values ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          params.transcriptPath,
          params.agentId ?? null,
          params.sessionId,
          row.seq,
          row.entryType,
          JSON.stringify(row.parsed),
        ],
      );
    }
  });
}

async function upsertTranscriptTailRows(params: {
  client: PostgresPersistenceClient;
  transcriptPath: string;
  sessionId: string;
  agentId?: string;
  rows: TranscriptRow[];
}): Promise<void> {
  await params.client.sql.begin(async (tx) => {
    await lockTranscript(tx, params.transcriptPath);
    for (const row of params.rows) {
      await tx.unsafe(
        `
          insert into ${params.client.schemaSql}.session_events
            (transcript_path, agent_id, session_id, seq, entry_type, payload)
          values ($1, $2, $3, $4, $5, $6::jsonb)
          on conflict (transcript_path, seq) do update
            set agent_id = excluded.agent_id,
                session_id = excluded.session_id,
                entry_type = excluded.entry_type,
                payload = excluded.payload
        `,
        [
          params.transcriptPath,
          params.agentId ?? null,
          params.sessionId,
          row.seq,
          row.entryType,
          JSON.stringify(row.parsed),
        ],
      );
    }
  });
}

function buildTranscriptTailRowsFromSessionManager(
  sessionManager: PersistableSessionManager,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const header = sessionManager.getHeader();
  if (header) {
    rows.push({
      seq: 1,
      entryType: header.type,
      parsed: header as unknown as Record<string, unknown>,
    });
  }
  const entries = sessionManager.getEntries();
  const tail = entries.at(-1);
  if (tail) {
    rows.push({
      seq: entries.length + (header ? 1 : 0),
      entryType: tail.type,
      parsed: tail as unknown as Record<string, unknown>,
    });
  }
  return rows;
}

function resolveSessionManagerTranscriptPath(
  sessionManager: PersistableSessionManager,
): string | undefined {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile?.trim()) {
    return undefined;
  }
  return normalizePersistencePathKey(sessionFile);
}

function resolveSessionManagerSessionId(
  transcriptPath: string,
  sessionManager: PersistableSessionManager,
  explicitSessionId?: string,
): string | undefined {
  const sessionId = explicitSessionId?.trim() || sessionManager.getSessionId()?.trim();
  if (sessionId) {
    return sessionId;
  }
  return resolveTranscriptSessionId(
    transcriptPath,
    buildTranscriptRowsFromSessionManager(sessionManager),
  );
}

function scheduleRuntimePersistence(label: string, run: () => Promise<void>): void {
  if (!isPostgresPersistenceEnabled()) {
    return;
  }
  const task = run().catch((error) => {
    log.warn(`${label} failed: ${summarizeError(error)}`);
  });
  trackBackgroundTask(task);
}

export async function waitForBackgroundPersistenceForTest(): Promise<void> {
  await Promise.all(backgroundTasks);
}

export async function persistSessionStoreSnapshot(
  params: {
    storePath: string;
    store: Record<string, SessionEntry>;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const client = await getPersistenceClient(options);
  if (!client) {
    return;
  }

  const storePath = normalizePersistencePathKey(params.storePath);
  const agentId = inferAgentIdFromAgentPath(storePath);
  const entries = Object.entries(params.store).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  await client.sql.begin(async (tx) => {
    await tx.unsafe(`delete from ${client.schemaSql}.sessions where store_path = $1`, [storePath]);
    for (const [sessionKey, entry] of entries) {
      await tx.unsafe(
        `
          insert into ${client.schemaSql}.sessions
            (store_path, session_key, agent_id, session_id, updated_at, payload)
          values ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          storePath,
          sessionKey,
          agentId ?? null,
          entry.sessionId,
          entry.updatedAt ?? Date.now(),
          JSON.stringify(entry),
        ],
      );
    }
  });
}

export async function syncTranscriptFileToPostgres(
  params: {
    transcriptPath: string;
    agentId?: string;
    sessionId?: string;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const lookupMode = options?.lookupMode ?? "runtime";
  const transcriptPath = normalizePersistencePathKey(params.transcriptPath);
  await withTranscriptQueue(transcriptPath, async () => {
    const client = await requirePersistenceClient({
      lookupMode,
      config: options?.config,
      env: options?.env,
    });
    let raw = "";
    try {
      raw = await fs.readFile(transcriptPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await client.sql.begin(async (tx) => {
          await lockTranscript(tx, transcriptPath);
          await tx.unsafe(
            `delete from ${client.schemaSql}.session_events where transcript_path = $1`,
            [transcriptPath],
          );
        });
        return;
      }
      throw error;
    }

    const rows = buildTranscriptRowsFromRaw(raw);
    const sessionId = params.sessionId?.trim()
      ? params.sessionId.trim()
      : resolveTranscriptSessionId(transcriptPath, rows);
    if (!sessionId) {
      return;
    }

    await replaceTranscriptRows({
      client,
      transcriptPath,
      sessionId,
      agentId: params.agentId ?? inferAgentIdFromAgentPath(transcriptPath),
      rows,
    });
  });
}

export async function syncSessionManagerToPostgres(
  params: {
    sessionManager: PersistableSessionManager;
    transcriptPath?: string;
    agentId?: string;
    sessionId?: string;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const lookupMode = options?.lookupMode ?? "runtime";
  const transcriptPath =
    params.transcriptPath?.trim() || resolveSessionManagerTranscriptPath(params.sessionManager);
  if (!transcriptPath) {
    return;
  }

  await withTranscriptQueue(transcriptPath, async () => {
    const client =
      lookupMode === "runtime"
        ? await getPersistenceClient({
            lookupMode,
            config: options?.config,
            env: options?.env,
          })
        : await requirePersistenceClient({
            lookupMode,
            config: options?.config,
            env: options?.env,
          });
    if (!client) {
      return;
    }
    const sessionId = resolveSessionManagerSessionId(
      transcriptPath,
      params.sessionManager,
      params.sessionId,
    );
    if (!sessionId) {
      return;
    }

    await replaceTranscriptRows({
      client,
      transcriptPath,
      sessionId,
      agentId: params.agentId ?? inferAgentIdFromAgentPath(transcriptPath),
      rows: buildTranscriptRowsFromSessionManager(params.sessionManager),
    });
  });
}

export function scheduleSessionManagerSyncToPostgres(params: {
  sessionManager: PersistableSessionManager;
  transcriptPath?: string;
  agentId?: string;
  sessionId?: string;
}): void {
  scheduleRuntimePersistence("session transcript persistence", async () => {
    await syncSessionManagerToPostgres(params);
  });
}

export function scheduleSessionManagerTailSyncToPostgres(params: {
  sessionManager: PersistableSessionManager;
  transcriptPath?: string;
  agentId?: string;
  sessionId?: string;
}): void {
  scheduleRuntimePersistence("session transcript tail persistence", async () => {
    const transcriptPath =
      params.transcriptPath?.trim() || resolveSessionManagerTranscriptPath(params.sessionManager);
    if (!transcriptPath) {
      return;
    }

    await withTranscriptQueue(transcriptPath, async () => {
      const client = await requirePersistenceClient({ lookupMode: "runtime" });
      const sessionId = resolveSessionManagerSessionId(
        transcriptPath,
        params.sessionManager,
        params.sessionId,
      );
      if (!sessionId) {
        return;
      }

      const rows = buildTranscriptTailRowsFromSessionManager(params.sessionManager);
      if (rows.length === 0) {
        return;
      }

      await upsertTranscriptTailRows({
        client,
        transcriptPath,
        sessionId,
        agentId: params.agentId ?? inferAgentIdFromAgentPath(transcriptPath),
        rows,
      });
    });
  });
}

export async function persistSubagentRegistryToPostgres(
  params: {
    runs: Map<string, SubagentRunRecord>;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const client = await requirePersistenceClient({
    lookupMode: options?.lookupMode ?? "configured",
    config: options?.config,
    env: options?.env,
  });
  const entries = [...params.runs.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  await client.sql.begin(async (tx) => {
    await tx.unsafe(`delete from ${client.schemaSql}.subagent_runs`);
    for (const [runId, entry] of entries) {
      const updatedAt =
        entry.endedAt ??
        entry.startedAt ??
        entry.cleanupCompletedAt ??
        entry.createdAt ??
        Date.now();
      await tx.unsafe(
        `
          insert into ${client.schemaSql}.subagent_runs
            (run_id, updated_at, payload)
          values ($1, $2, $3::jsonb)
        `,
        [runId, updatedAt, JSON.stringify(entry)],
      );
    }
  });
}

function sanitizeCredentialForMetadata(credential: AuthProfileCredential): {
  metadata: Record<string, unknown>;
  secret?: Record<string, unknown>;
} {
  if (credential.type === "api_key") {
    const { key, ...rest } = credential;
    return {
      metadata: rest,
      secret: key ? { key } : undefined,
    };
  }
  if (credential.type === "token") {
    const { token, ...rest } = credential;
    return {
      metadata: rest,
      secret: token ? { token } : undefined,
    };
  }
  const { access, refresh, ...rest } = credential;
  const secret: Record<string, unknown> = {};
  if (typeof access === "string" && access.trim()) {
    secret.access = access;
  }
  if (typeof refresh === "string" && refresh.trim()) {
    secret.refresh = refresh;
  }
  return {
    metadata: rest,
    secret: Object.keys(secret).length > 0 ? secret : undefined,
  };
}

function splitAuthProfileSecrets(store: AuthProfileStore): {
  metadataStore: PersistedAuthProfileMetadataStore;
  secrets: AuthSecretRecord[];
} {
  const profiles: PersistedAuthProfileMetadataStore["profiles"] = {};
  const secrets: AuthSecretRecord[] = [];
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    const sanitized = sanitizeCredentialForMetadata(credential);
    profiles[profileId] = sanitized.metadata;
    if (sanitized.secret) {
      secrets.push({ profileId, value: sanitized.secret });
    }
  }
  return {
    metadataStore: {
      version: store.version,
      profiles,
      order: store.order ?? undefined,
      lastGood: store.lastGood ?? undefined,
      usageStats: store.usageStats ?? undefined,
    },
    secrets,
  };
}

function restoreCredentialFromPersistence(params: {
  profileId: string;
  metadata: Record<string, unknown>;
  secret?: Record<string, unknown>;
}): AuthProfileCredential | null {
  const type = params.metadata.type;
  const provider = params.metadata.provider;
  if (typeof type !== "string" || typeof provider !== "string") {
    return null;
  }
  const record = {
    ...params.metadata,
    ...params.secret,
  } as Record<string, unknown>;
  if (type === "api_key") {
    return record as AuthProfileCredential;
  }
  if (type === "token") {
    return record as AuthProfileCredential;
  }
  if (type === "oauth") {
    return record as AuthProfileCredential;
  }
  log.warn(`ignored unsupported auth profile type from postgres: ${type}`, {
    profileId: params.profileId,
  });
  return null;
}

export async function persistAuthProfileStoreToPostgres(
  params: {
    store: AuthProfileStore;
    agentDir?: string;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const client = await requirePersistenceClient({
    lookupMode: options?.lookupMode ?? "configured",
    config: options?.config,
    env: options?.env,
  });
  const storeKey = normalizePersistencePathKey(resolveAuthStorePath(params.agentDir));
  const agentScope = inferAgentIdFromAgentPath(storeKey);
  const split = splitAuthProfileSecrets(params.store);
  if (split.secrets.length > 0 && !client.config.encryptionKey) {
    throw new Error("persistence.postgres.encryptionKey is required to import auth secrets.");
  }

  await client.sql.begin(async (tx) => {
    await tx.unsafe(
      `
        insert into ${client.schemaSql}.auth_profiles
          (store_key, agent_scope, updated_at, payload)
        values ($1, $2, $3, $4::jsonb)
        on conflict (store_key) do update
          set agent_scope = excluded.agent_scope,
              updated_at = excluded.updated_at,
              payload = excluded.payload
      `,
      [storeKey, agentScope ?? null, Date.now(), JSON.stringify(split.metadataStore)],
    );
    await tx.unsafe(`delete from ${client.schemaSql}.auth_secrets where store_key = $1`, [
      storeKey,
    ]);
    for (const secret of split.secrets) {
      await tx.unsafe(
        `
          insert into ${client.schemaSql}.auth_secrets
            (store_key, profile_id, updated_at, payload)
          values ($1, $2, $3, $4::jsonb)
        `,
        [
          storeKey,
          secret.profileId,
          Date.now(),
          JSON.stringify(encryptJsonValue(secret.value, client.config.encryptionKey!)),
        ],
      );
    }
  });
}

export async function loadAuthProfileStoreSnapshotsFromPostgres(options?: {
  lookupMode?: PostgresPersistenceLookupMode;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<Array<{ agentDir: string; store: AuthProfileStore }>> {
  const client = await getPersistenceClient(options);
  if (!client) {
    return [];
  }

  const metadataRows = await client.sql.unsafe<
    Array<{ store_key: string; payload: PersistedAuthProfileMetadataStore }>
  >(`select store_key, payload from ${client.schemaSql}.auth_profiles order by store_key asc`);
  if (metadataRows.length === 0) {
    return [];
  }

  const secretRows = await client.sql.unsafe<
    Array<{ store_key: string; profile_id: string; payload: EncryptedJsonPayload }>
  >(
    `select store_key, profile_id, payload from ${client.schemaSql}.auth_secrets order by store_key asc`,
  );
  const secretsByStore = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of secretRows) {
    if (!client.config.encryptionKey) {
      throw new Error("persistence.postgres.encryptionKey is required to read auth secrets.");
    }
    const storeSecrets =
      secretsByStore.get(row.store_key) ?? new Map<string, Record<string, unknown>>();
    storeSecrets.set(
      row.profile_id,
      decryptJsonValue<Record<string, unknown>>(row.payload, client.config.encryptionKey),
    );
    secretsByStore.set(row.store_key, storeSecrets);
  }

  const stores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  for (const row of metadataRows) {
    const metadataStore = row.payload;
    const profiles: AuthProfileStore["profiles"] = {};
    const storeSecrets = secretsByStore.get(row.store_key);
    for (const [profileId, metadata] of Object.entries(metadataStore.profiles ?? {})) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        continue;
      }
      const credential = restoreCredentialFromPersistence({
        profileId,
        metadata,
        secret: storeSecrets?.get(profileId),
      });
      if (credential) {
        profiles[profileId] = credential;
      }
    }
    stores.push({
      agentDir: normalizePersistencePathKey(path.dirname(row.store_key)),
      store: {
        version: Number(metadataStore.version ?? 1),
        profiles,
        order: metadataStore.order ?? undefined,
        lastGood: metadataStore.lastGood ?? undefined,
        usageStats: metadataStore.usageStats ?? undefined,
      },
    });
  }
  return stores;
}

export async function syncMemoryDocumentToPostgres(
  params: {
    workspaceRoot: string;
    absolutePath: string;
    logicalPath: string;
    body?: string;
    agentId?: string;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return;
  }
  const client = await requirePersistenceClient({
    lookupMode: options?.lookupMode ?? "configured",
    config: options?.config,
    env: options?.env,
  });
  await syncMemoryDocumentWithClient(client, {
    workspaceRoot: params.workspaceRoot,
    absolutePath: params.absolutePath,
    logicalPath,
    body: params.body,
    agentId: params.agentId,
  });
}

async function syncMemoryDocumentWithClient(
  client: PostgresPersistenceClient,
  params: {
    workspaceRoot: string;
    absolutePath: string;
    logicalPath: string;
    body?: string;
    agentId?: string;
  },
): Promise<void> {
  const workspaceRoot = normalizePersistencePathKey(params.workspaceRoot);
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return;
  }
  let body = params.body;
  if (body === undefined) {
    try {
      body = await fs.readFile(params.absolutePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await client.sql.unsafe(
          `delete from ${client.schemaSql}.memory_documents where workspace_root = $1 and logical_path = $2`,
          [workspaceRoot, logicalPath],
        );
        return;
      }
      throw error;
    }
  }
  await client.sql.unsafe(
    `
      insert into ${client.schemaSql}.memory_documents
        (workspace_root, logical_path, agent_id, updated_at, body, meta)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      on conflict (workspace_root, logical_path) do update
        set agent_id = excluded.agent_id,
            updated_at = excluded.updated_at,
            body = excluded.body,
            meta = excluded.meta
    `,
    [
      workspaceRoot,
      logicalPath,
      params.agentId ?? null,
      Date.now(),
      body,
      JSON.stringify({
        absolutePath: normalizePersistencePathKey(params.absolutePath),
      }),
    ],
  );
}

async function deleteMemoryDocumentWithClient(
  client: PostgresPersistenceClient,
  params: { workspaceRoot: string; logicalPath: string },
): Promise<void> {
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return;
  }
  await client.sql.unsafe(
    `delete from ${client.schemaSql}.memory_documents where workspace_root = $1 and logical_path = $2`,
    [normalizePersistencePathKey(params.workspaceRoot), logicalPath],
  );
}

async function exportMemoryDocumentCompatibility(params: {
  workspaceRoot: string;
  logicalPath: string;
  body?: string;
}): Promise<void> {
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return;
  }
  if (params.body === undefined) {
    await fs.rm(path.join(params.workspaceRoot, logicalPath), { force: true });
    return;
  }
  await writeFileWithinRoot({
    rootDir: params.workspaceRoot,
    relativePath: logicalPath,
    data: params.body,
    encoding: "utf8",
    mkdir: true,
  });
}

export async function persistMemoryDocumentCanonical(params: {
  workspaceRoot: string;
  logicalPath: string;
  body?: string;
  agentId?: string;
  absolutePath?: string;
}): Promise<void> {
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return;
  }
  const client = await requirePersistenceClient({ lookupMode: "runtime" });
  const workspaceRoot = normalizePersistencePathKey(params.workspaceRoot);
  const absolutePath = params.absolutePath ?? path.join(workspaceRoot, logicalPath);

  if (params.body === undefined) {
    await deleteMemoryDocumentWithClient(client, {
      workspaceRoot,
      logicalPath,
    });
  } else {
    await syncMemoryDocumentWithClient(client, {
      workspaceRoot,
      absolutePath,
      logicalPath,
      body: params.body,
      agentId: params.agentId,
    });
  }

  if (client.config.exportCompatibility) {
    await exportMemoryDocumentCompatibility({
      workspaceRoot,
      logicalPath,
      body: params.body,
    });
  }
}

export async function reconcileMemoryDocumentFromFilesystemToPostgres(
  params: {
    workspaceRoot: string;
    logicalPath: string;
    agentId?: string;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<boolean> {
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return false;
  }
  const client = await getPersistenceClient(options);
  if (!client) {
    return false;
  }
  const workspaceRoot = normalizePersistencePathKey(params.workspaceRoot);
  const absolutePath = path.join(workspaceRoot, logicalPath);
  await syncMemoryDocumentWithClient(client, {
    workspaceRoot,
    absolutePath,
    logicalPath,
    agentId: params.agentId,
  });
  return true;
}

export async function reconcileWorkspaceMemoryDocumentsToPostgres(
  params: {
    workspaceRoot: string;
    agentId?: string;
  },
  options?: {
    lookupMode?: PostgresPersistenceLookupMode;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ upserted: number; deleted: number }> {
  const client = await getPersistenceClient(options);
  if (!client) {
    return { upserted: 0, deleted: 0 };
  }

  const workspaceRoot = normalizePersistencePathKey(params.workspaceRoot);
  const currentLogicalPaths = new Map<string, string>();
  for (const absolutePath of await listMemoryFiles(workspaceRoot)) {
    const relativePath = resolvePathRelativeToRoot(workspaceRoot, absolutePath);
    const logicalPath = relativePath ? normalizeMemoryDocumentPath(relativePath) : undefined;
    if (!logicalPath) {
      continue;
    }
    currentLogicalPaths.set(logicalPath, absolutePath);
    await syncMemoryDocumentWithClient(client, {
      workspaceRoot,
      absolutePath,
      logicalPath,
      agentId: params.agentId,
    });
  }

  const rows = await client.sql.unsafe<Array<{ logical_path: string }>>(
    `
      select logical_path
      from ${client.schemaSql}.memory_documents
      where workspace_root = $1
    `,
    [workspaceRoot],
  );

  let deleted = 0;
  for (const row of rows) {
    const logicalPath = normalizeMemoryDocumentPath(row.logical_path);
    if (!logicalPath || currentLogicalPaths.has(logicalPath)) {
      continue;
    }
    await client.sql.unsafe(
      `delete from ${client.schemaSql}.memory_documents where workspace_root = $1 and logical_path = $2`,
      [workspaceRoot, logicalPath],
    );
    deleted += 1;
  }

  return {
    upserted: currentLogicalPaths.size,
    deleted,
  };
}

export async function readMemoryDocumentFromPostgres(params: {
  workspaceRoot: string;
  logicalPath: string;
  lookupMode?: PostgresPersistenceLookupMode;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return null;
  }
  const client = await getPersistenceClient(params);
  if (!client) {
    return null;
  }
  const workspaceRoot = normalizePersistencePathKey(params.workspaceRoot);
  const rows = await client.sql.unsafe<Array<{ body: string }>>(
    `
      select body
      from ${client.schemaSql}.memory_documents
      where workspace_root = $1 and logical_path = $2
      limit 1
    `,
    [workspaceRoot, logicalPath],
  );
  return typeof rows[0]?.body === "string" ? rows[0].body : null;
}

export async function loadSubagentRunsFromPostgres(options?: {
  lookupMode?: PostgresPersistenceLookupMode;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<Map<string, SubagentRunRecord>> {
  const client = await getPersistenceClient(options);
  if (!client) {
    return new Map();
  }
  const rows = await client.sql.unsafe<Array<{ run_id: string; payload: SubagentRunRecord }>>(
    `select run_id, payload from ${client.schemaSql}.subagent_runs order by run_id asc`,
  );
  const runs = new Map<string, SubagentRunRecord>();
  for (const row of rows) {
    if (!row.run_id || !row.payload) {
      continue;
    }
    runs.set(row.run_id, row.payload);
  }
  return runs;
}

export function scheduleAuthProfileStorePersistenceToPostgres(params: {
  store: AuthProfileStore;
  agentDir?: string;
}): void {
  const storeKey = normalizePersistencePathKey(resolveAuthStorePath(params.agentDir));
  scheduleRuntimePersistence("auth profile persistence", async () => {
    await runSerializedByKey(authStoreQueues, storeKey, async () => {
      await persistAuthProfileStoreToPostgres(
        {
          store: structuredClone(params.store),
          agentDir: params.agentDir,
        },
        { lookupMode: "runtime" },
      );
    });
  });
}

export function scheduleSubagentRegistryPersistenceToPostgres(params: {
  runs: Map<string, SubagentRunRecord>;
}): void {
  scheduleRuntimePersistence("subagent registry persistence", async () => {
    await runSerializedByKey(registryQueues, "subagent-registry", async () => {
      await persistSubagentRegistryToPostgres(
        {
          runs: new Map(
            [...params.runs.entries()].map(([runId, entry]) => [runId, structuredClone(entry)]),
          ),
        },
        { lookupMode: "runtime" },
      );
    });
  });
}

export function scheduleMemoryDocumentSyncToPostgres(params: {
  workspaceRoot: string;
  absolutePath: string;
  logicalPath: string;
  body?: string;
  agentId?: string;
}): void {
  const logicalPath = normalizeMemoryDocumentPath(params.logicalPath);
  if (!logicalPath) {
    return;
  }
  const workspaceRoot = normalizePersistencePathKey(params.workspaceRoot);
  const queueKey = `${workspaceRoot}\0${logicalPath.toLowerCase()}`;
  scheduleRuntimePersistence("memory document persistence", async () => {
    await runSerializedByKey(memoryDocumentQueues, queueKey, async () => {
      await syncMemoryDocumentToPostgres(
        {
          workspaceRoot,
          absolutePath: params.absolutePath,
          logicalPath,
          body: params.body,
          agentId: params.agentId,
        },
        { lookupMode: "runtime" },
      );
    });
  });
}
