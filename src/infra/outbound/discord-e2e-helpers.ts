import { randomUUID } from "node:crypto";
/**
 * Live Discord E2E test helpers.
 *
 * These helpers support the Phase 7 live Discord surface harness. They are
 * test-only: production code must not import them. The harness spawns an ACP
 * session through the real gateway, observes real Discord threads/messages,
 * and asserts that the delivery surface matches the webhook/thread/identity
 * contract documented in the Discord Surface Overhaul plan.
 *
 * All REST calls go through @buape/carbon's RequestClient (the same client the
 * Discord extension uses) so request fingerprint, auth header handling, and
 * rate-limit behavior stay consistent with production.
 */
import { RequestClient } from "@buape/carbon";
import type { APIMessage } from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import type { GatewayClient } from "../../gateway/client.js";
import { sleep } from "../../utils.js";
import { isTruthyEnvValue } from "../env.js";

/**
 * Required environment for live Discord E2E tests. We keep a separate
 * bot token from the production DISCORD_BOT_TOKEN so test flakes or
 * webhook/thread writes cannot pollute a real user's server.
 */
export interface DiscordE2EEnv {
  botToken: string;
  guildId: string;
  parentChannelId: string;
  accountId: string;
  secondaryChannelId?: string;
}

const LIVE_DISCORD_FLAG = "OPENCLAW_LIVE_DISCORD";
const LIVE_DISCORD_VARS = [
  "OPENCLAW_LIVE_DISCORD_BOT_TOKEN",
  "OPENCLAW_LIVE_DISCORD_GUILD_ID",
  "OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID",
] as const;

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the live E2E environment. Throws a clear error listing which
 * variables are missing so operators do not have to guess.
 */
export function resolveDiscordE2EEnv(): DiscordE2EEnv {
  const botToken = readEnv("OPENCLAW_LIVE_DISCORD_BOT_TOKEN");
  const guildId = readEnv("OPENCLAW_LIVE_DISCORD_GUILD_ID");
  const parentChannelId = readEnv("OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID");
  const missing: string[] = [];
  if (!botToken) {
    missing.push("OPENCLAW_LIVE_DISCORD_BOT_TOKEN");
  }
  if (!guildId) {
    missing.push("OPENCLAW_LIVE_DISCORD_GUILD_ID");
  }
  if (!parentChannelId) {
    missing.push("OPENCLAW_LIVE_DISCORD_PARENT_CHANNEL_ID");
  }
  if (!botToken || !guildId || !parentChannelId) {
    throw new Error(
      `live Discord E2E env incomplete: missing ${missing.join(", ")} (set OPENCLAW_LIVE_DISCORD=1 with all of: ${LIVE_DISCORD_VARS.join(", ")})`,
    );
  }
  const accountId = readEnv("OPENCLAW_LIVE_DISCORD_ACCOUNT_ID") ?? "default";
  const secondaryChannelId = readEnv("OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID");
  return {
    botToken,
    guildId,
    parentChannelId,
    accountId,
    secondaryChannelId,
  };
}

/**
 * Gate helper: true only when both the master flag and all required envs
 * are present. Used by describe.skip() guards so default CI never fails
 * for lack of live creds.
 */
export function isDiscordE2EEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isTruthyEnvValue(env[LIVE_DISCORD_FLAG])) {
    return false;
  }
  return LIVE_DISCORD_VARS.every((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * Forbidden substrings/patterns. If any of these appear in a thread after
 * binding, the delivery layer regressed and leaked internal chatter into
 * the user-facing surface. Keep the list conservative — add more via the
 * opts.forbidden override, not here.
 */
export const FORBIDDEN_CHATTER_DEFAULT: readonly (string | RegExp)[] = [
  "Using browser-autopilot",
  "Back online",
  "Background task done",
  "CLI fallback",
  /temp-dir/i,
  "thread lookup",
  /sandbox debugging/i,
] as const;

type RestClient = RequestClient;

const restClientCache = new Map<string, RestClient>();

function getRestClient(token: string): RestClient {
  let rest = restClientCache.get(token);
  if (!rest) {
    rest = new RequestClient(token);
    restClientCache.set(token, rest);
  }
  return rest;
}

/**
 * Retry wrapper for Discord REST calls. Honors 429 retry-after headers
 * via RequestClient's built-in scheduler, but also provides an outer
 * safety net with bounded attempts + jittered backoff in case of transient
 * network or 5xx errors.
 */
export async function withDiscordRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 4);
  const baseDelayMs = Math.max(25, opts?.baseDelayMs ?? 400);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      const retryAfterMs = extractRetryAfterMs(error);
      const backoff =
        typeof retryAfterMs === "number" ? retryAfterMs : baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * Math.min(250, backoff));
      await sleep(backoff + jitter);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  if (status !== 429) {
    return undefined;
  }
  const candidates: unknown[] = [
    (error as { retryAfterMs?: unknown }).retryAfterMs,
    (error as { retry_after?: unknown }).retry_after,
    (error as { retryAfter?: unknown }).retryAfter,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      // Treat small values as seconds (Discord convention), large as ms.
      return candidate < 120 ? Math.floor(candidate * 1000) : Math.floor(candidate);
    }
  }
  return undefined;
}

/**
 * Spawn an ACP session bound to a fresh Discord thread.
 *
 * Returns the newly created thread id, the spawned session key, and the
 * id of the request message that triggered the spawn. Callers can use the
 * threadId to assert on delivery surface behavior.
 */
export async function spawnAcpWithMarker(params: {
  agentId: "claude" | "codex";
  marker: string;
  task: string;
  env: DiscordE2EEnv;
  gateway: GatewayClient;
  gatewayEnv: { port: number; token: string };
  timeoutMs?: number;
}): Promise<{ threadId: string; spawnedSessionKey: string; requestMessageId: string }> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  const startedAt = Date.now();

  // Post the spawn request into the parent channel. The production classifier
  // and spawn path will create a thread for the new ACP session.
  const messageContent = `/acp spawn ${params.agentId} --bind here\n${params.task}\n${params.marker}`;
  const request = await withDiscordRetry(() =>
    postDiscordMessage(params.env, params.env.parentChannelId, messageContent),
  );
  const requestMessageId = request.id;

  // Trigger the gateway-side spawn over RPC. We piggyback on chat.send with
  // the parent channel as originatingTo so routing replicates real Discord flow.
  const sessionKey = `discord:parent:${params.env.parentChannelId}`;
  const spawnResult: { runId?: string; status?: string } = await params.gateway.request(
    "chat.send",
    {
      sessionKey,
      message: `/acp spawn ${params.agentId} --bind here`,
      idempotencyKey: `idem-spawn-${randomUUID()}`,
      originatingChannel: "discord",
      originatingTo: params.env.parentChannelId,
      originatingAccountId: params.env.accountId,
    },
  );
  if (spawnResult?.status !== "started" || typeof spawnResult.runId !== "string") {
    throw new Error(`chat.send for spawn did not start correctly: ${JSON.stringify(spawnResult)}`);
  }
  await params.gateway.request(
    "agent.wait",
    { runId: spawnResult.runId, timeoutMs: Math.max(30_000, timeoutMs - (Date.now() - startedAt)) },
    { timeoutMs: Math.max(35_000, timeoutMs - (Date.now() - startedAt) + 5_000) },
  );

  // Pull history for the main session so we can extract the spawned session key.
  const history: { messages?: unknown[] } = await params.gateway.request("chat.history", {
    sessionKey,
    limit: 16,
  });
  const spawnedSessionKey = extractSpawnedAcpSessionKey(history.messages ?? []);
  if (!spawnedSessionKey) {
    throw new Error("could not extract spawned ACP session key from chat.history");
  }

  // Find the newly created thread containing our marker. ACP spawn creates a
  // thread via the Discord extension; we poll until it shows up.
  const threadId = await withDiscordRetry(() =>
    findThreadWithMarker({
      env: params.env,
      marker: params.marker,
      timeoutMs: Math.max(15_000, timeoutMs - (Date.now() - startedAt)),
    }),
  );

  return { threadId, spawnedSessionKey, requestMessageId };
}

/**
 * Post a follow-up message into an already-bound thread and wait for the
 * agent to respond on the bound session key.
 */
export async function followUpInBoundThread(params: {
  threadId: string;
  spawnedSessionKey: string;
  text: string;
  env: DiscordE2EEnv;
  gateway: GatewayClient;
  timeoutMs?: number;
}): Promise<{ runId: string }> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  const result: { runId?: string; status?: string } = await params.gateway.request("chat.send", {
    sessionKey: params.spawnedSessionKey,
    message: params.text,
    idempotencyKey: `idem-followup-${randomUUID()}`,
    originatingChannel: "discord",
    originatingTo: params.threadId,
    originatingAccountId: params.env.accountId,
  });
  if (result?.status !== "started" || typeof result.runId !== "string") {
    throw new Error(`follow-up chat.send did not start: ${JSON.stringify(result)}`);
  }
  await params.gateway.request(
    "agent.wait",
    { runId: result.runId, timeoutMs },
    { timeoutMs: timeoutMs + 5_000 },
  );
  return { runId: result.runId };
}

/**
 * Assert that a marker string appears in visible thread messages.
 * Uses jittered backoff polling so we absorb Discord REST propagation delay.
 * Returns the matched message for further assertions (author identity, etc).
 */
export async function assertVisibleInThread(params: {
  threadId: string;
  marker: string;
  env: DiscordE2EEnv;
  timeoutMs?: number;
  minCount?: number;
}): Promise<APIMessage> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const minCount = Math.max(1, params.minCount ?? 1);
  const startedAt = Date.now();
  let lastMessages: APIMessage[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    lastMessages = await withDiscordRetry(() =>
      readThreadMessages(params.env, params.threadId, 50),
    );
    const matches = lastMessages.filter((msg) => msg.content?.includes(params.marker));
    if (matches.length >= minCount) {
      // Return the earliest matching message so callers can assert identity.
      const ordered = matches.toSorted((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      const first = ordered[0];
      if (!first) {
        throw new Error("matches list empty after sort");
      }
      return first;
    }
    const jitter = 250 + Math.floor(Math.random() * 500);
    await sleep(1_000 + jitter);
  }
  throw new Error(
    `assertVisibleInThread: marker ${JSON.stringify(params.marker)} not seen in thread ${
      params.threadId
    } within ${String(timeoutMs)}ms (saw ${String(lastMessages.length)} messages)`,
  );
}

/**
 * Assert that none of the forbidden patterns appear in a thread.
 * Scans the most recent N messages (default 50).
 */
export async function assertNoForbiddenChatter(params: {
  threadId: string;
  env: DiscordE2EEnv;
  scanLimit?: number;
  forbidden?: readonly (string | RegExp)[];
}): Promise<void> {
  const scanLimit = Math.max(1, Math.min(params.scanLimit ?? 50, 100));
  const forbidden = params.forbidden ?? FORBIDDEN_CHATTER_DEFAULT;
  const messages = await withDiscordRetry(() =>
    readThreadMessages(params.env, params.threadId, scanLimit),
  );
  const violations: Array<{ messageId: string; pattern: string; content: string }> = [];
  for (const msg of messages) {
    const content = msg.content ?? "";
    for (const pattern of forbidden) {
      const hit = typeof pattern === "string" ? content.includes(pattern) : pattern.test(content);
      if (hit) {
        violations.push({
          messageId: msg.id,
          pattern: typeof pattern === "string" ? pattern : pattern.source,
          content: content.slice(0, 200),
        });
      }
    }
  }
  if (violations.length > 0) {
    const summary = violations
      .map((v) => `  - ${v.messageId}: /${v.pattern}/ in ${JSON.stringify(v.content)}`)
      .join("\n");
    throw new Error(
      `assertNoForbiddenChatter: ${String(violations.length)} forbidden pattern hit(s) in thread ${
        params.threadId
      }:\n${summary}`,
    );
  }
}

/**
 * Assert that a message was authored by the expected identity. We check
 * webhook presence (vs bot), optional username match, and optional bot flag.
 */
export function assertAuthorIdentity(
  message: APIMessage,
  expected: {
    webhookId: "present" | "absent";
    username?: string | RegExp;
    bot?: boolean;
  },
): void {
  const author = message.author;
  // `webhook_id` lives on the message (not the author) per discord-api-types v10.
  const webhookId = message.webhook_id;
  if (expected.webhookId === "present" && !webhookId) {
    throw new Error(
      `assertAuthorIdentity: expected webhook author for message ${message.id}, got bot=${String(
        author?.bot,
      )} username=${JSON.stringify(author?.username)}`,
    );
  }
  if (expected.webhookId === "absent" && webhookId) {
    throw new Error(
      `assertAuthorIdentity: expected non-webhook author for message ${message.id}, got webhook_id=${webhookId}`,
    );
  }
  if (expected.username !== undefined) {
    const username = author?.username ?? "";
    const matches =
      typeof expected.username === "string"
        ? username === expected.username
        : expected.username.test(username);
    if (!matches) {
      throw new Error(
        `assertAuthorIdentity: username mismatch on message ${
          message.id
        }: expected ${String(expected.username)}, got ${JSON.stringify(username)}`,
      );
    }
  }
  if (expected.bot !== undefined) {
    const bot = author?.bot === true;
    if (bot !== expected.bot) {
      throw new Error(
        `assertAuthorIdentity: bot flag mismatch on message ${message.id}: expected ${String(
          expected.bot,
        )}, got ${String(bot)}`,
      );
    }
  }
}

/**
 * Assert that the session transcript contains the marker. This is separate
 * from Discord-visible assertions so we can tell whether a regression is in
 * the model/session layer vs the Discord delivery layer.
 */
export async function assertSessionHistoryContains(params: {
  gateway: GatewayClient;
  sessionKey: string;
  marker: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const history: { messages?: unknown[] } = await params.gateway.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: 32,
    });
    const messages = history.messages ?? [];
    const joined = messages
      .map((m) => {
        if (!m || typeof m !== "object") {
          return "";
        }
        const content = (m as { content?: unknown }).content;
        return typeof content === "string" ? content : JSON.stringify(content ?? "");
      })
      .join("\n");
    if (joined.includes(params.marker)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(
    `assertSessionHistoryContains: marker ${JSON.stringify(
      params.marker,
    )} not seen in session ${params.sessionKey} within ${String(timeoutMs)}ms`,
  );
}

/**
 * Archive a thread and close its ACP session. Swallows errors because
 * cleanup must not mask the test's real failure reason.
 */
export async function cleanupBinding(params: {
  threadId: string;
  sessionKey?: string;
  env: DiscordE2EEnv;
  gateway?: GatewayClient;
}): Promise<void> {
  try {
    await archiveThread(params.env, params.threadId);
  } catch {
    /* swallow: cleanup best-effort */
  }
  if (params.sessionKey && params.gateway) {
    try {
      await params.gateway.request("sessions.delete", {
        key: params.sessionKey,
        deleteTranscript: false,
        emitLifecycleHooks: false,
      });
    } catch {
      /* swallow: cleanup best-effort */
    }
  }
}

/**
 * Rebind an existing parent session to a new thread (future P2 scenario).
 * Creates a new public thread in the secondary channel and issues a bind
 * RPC to point the existing parent session at it.
 */
export async function rebindParentToNewThread(params: {
  parentSessionKey: string;
  newParentChannelId: string;
  env: DiscordE2EEnv;
  gateway: GatewayClient;
}): Promise<{ newThreadId: string }> {
  const thread = await withDiscordRetry(() =>
    createDiscordThread(params.env, params.newParentChannelId, {
      name: `openclaw-e2e-rebind-${randomUUID().slice(0, 8)}`,
    }),
  );
  const threadId = thread.id;
  await params.gateway.request("chat.send", {
    sessionKey: params.parentSessionKey,
    message: `/acp rebind --thread ${threadId}`,
    idempotencyKey: `idem-rebind-${randomUUID()}`,
    originatingChannel: "discord",
    originatingTo: threadId,
    originatingAccountId: params.env.accountId,
  });
  return { newThreadId: threadId };
}

// --- REST helpers (internal) --------------------------------------------------

async function postDiscordMessage(
  env: DiscordE2EEnv,
  channelId: string,
  content: string,
): Promise<{ id: string; channel_id: string }> {
  const rest = getRestClient(env.botToken);
  const res = (await rest.post(Routes.channelMessages(channelId), {
    body: { content },
  })) as { id: string; channel_id: string };
  return res;
}

async function readThreadMessages(
  env: DiscordE2EEnv,
  channelId: string,
  limit: number,
): Promise<APIMessage[]> {
  const rest = getRestClient(env.botToken);
  const res = (await rest.get(Routes.channelMessages(channelId), {
    limit,
  })) as APIMessage[];
  return res;
}

async function archiveThread(env: DiscordE2EEnv, threadId: string): Promise<void> {
  const rest = getRestClient(env.botToken);
  await rest.patch(Routes.channel(threadId), {
    body: { archived: true, locked: false },
  });
}

async function createDiscordThread(
  env: DiscordE2EEnv,
  parentChannelId: string,
  payload: { name: string },
): Promise<{ id: string }> {
  const rest = getRestClient(env.botToken);
  const res = (await rest.post(Routes.threads(parentChannelId), {
    body: {
      name: payload.name,
      auto_archive_duration: 60,
      type: 11, // PublicThread
    },
  })) as { id: string };
  return res;
}

async function findThreadWithMarker(params: {
  env: DiscordE2EEnv;
  marker: string;
  timeoutMs: number;
}): Promise<string> {
  const { env, marker, timeoutMs } = params;
  const startedAt = Date.now();
  const rest = getRestClient(env.botToken);
  while (Date.now() - startedAt < timeoutMs) {
    const active = (await rest.get(Routes.guildActiveThreads(env.guildId))) as {
      threads?: Array<{ id: string; parent_id?: string; name?: string }>;
    };
    const threads = active.threads ?? [];
    for (const thread of threads) {
      if (thread.parent_id && thread.parent_id !== env.parentChannelId) {
        continue;
      }
      // Scan the thread's messages for the marker.
      const messages = (await rest.get(Routes.channelMessages(thread.id), {
        limit: 25,
      })) as APIMessage[];
      if (messages.some((msg) => msg.content?.includes(marker))) {
        return thread.id;
      }
    }
    await sleep(1_000 + Math.floor(Math.random() * 500));
  }
  throw new Error(
    `findThreadWithMarker: no thread with marker ${JSON.stringify(marker)} within ${String(timeoutMs)}ms`,
  );
}

function extractSpawnedAcpSessionKey(messages: unknown[]): string | null {
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const content = (entry as { content?: unknown }).content;
    const text = typeof content === "string" ? content : content ? JSON.stringify(content) : "";
    const match = text.match(/Spawned ACP session (\S+) \(/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}
