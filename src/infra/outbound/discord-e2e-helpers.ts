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

// Trace logging for the live Discord E2E harness. Enabled whenever
// `OPENCLAW_E2E_VERBOSE=1`, which is the same flag the e2e vitest config
// uses to set `silent: false`. Tracing is test-diagnostic only — without it
// the harness hangs silently because vitest buffers stdout until failure.
function e2eTrace(message: string): void {
  if (process.env.OPENCLAW_E2E_VERBOSE === "1") {
    console.info(`[discord-e2e] ${message}`);
  }
}

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

/**
 * Known secret / leak patterns the progress sanitizer is expected to scrub
 * before a post reaches Discord. Used by red-team E2Es to assert that leaky
 * content from a child agent does not survive the emission boundary.
 *
 * Each entry is either a literal substring (matched with String#includes) or
 * a RegExp (matched with RegExp#test against content). Keep the list narrow
 * — reuse the unit-tier sanitizer tests in assistant-visible-text.test.ts
 * for coverage of the raw sanitizer contract.
 */
export const LEAK_PATTERNS_DEFAULT: readonly (string | RegExp)[] = [
  // Absolute filesystem paths that reveal user home directories.
  /\/home\/[A-Za-z0-9_.-]+\//,
  /\/Users\/[A-Za-z0-9_.-]+\//,
  /\/root\//,
  /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+\\/,
  // Secret-shaped tokens. These are literal substrings so the test fails with
  // the actual token body in the error — making regressions easy to diagnose.
  "Bearer fake_abc123def456ghi789jkl",
  "sk-ant-fake",
  "sk-fake",
  "ghp_fakegithubpat",
  // Node.js stack-trace frames.
  /^\s{2,}at\s+\S+\s*\([^\n)]*:\d+:\d+\)\s*$/m,
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
  //
  // Note: we use `--thread auto`. For Discord (a child-placement channel),
  // `--thread here` requires already being in a thread; `--bind here` would
  // bind to the parent channel without creating a child thread. Only
  // `--thread auto` auto-creates a new Discord thread when issued from the
  // parent channel, which is exactly what this surface test needs.
  const messageContent = `/acp spawn ${params.agentId} --thread auto\n${params.task}\n${params.marker}`;
  e2eTrace(`spawnAcpWithMarker: posting Discord message (agent=${params.agentId})`);
  const request = await withDiscordRetry(() =>
    postDiscordMessage(params.env, params.env.parentChannelId, messageContent),
  );
  const requestMessageId = request.id;
  e2eTrace(`spawnAcpWithMarker: parent message posted id=${requestMessageId}`);

  // Trigger the gateway-side spawn over RPC. We piggyback on chat.send with
  // the parent channel as originatingTo so routing replicates real Discord flow.
  const sessionKey = `discord:parent:${params.env.parentChannelId}`;

  // Wait for the ACP backend to be healthy before spawning. The acpx plugin
  // registers its backend on start, but `probeAvailability()` runs async —
  // spawning immediately races the probe and hits ACP_BACKEND_UNAVAILABLE.
  // Mirror the known-working gateway-acp-bind.live.test.ts approach: await
  // the probe explicitly and retry until healthy (or timeout).
  e2eTrace("spawnAcpWithMarker: waiting for acpx backend healthy");
  await waitForAcpBackendHealthy({ timeoutMs: Math.min(60_000, timeoutMs) });
  e2eTrace("spawnAcpWithMarker: backend healthy, sending spawn chat.send");

  const spawnResult: { runId?: string; status?: string } = await params.gateway.request(
    "chat.send",
    {
      sessionKey,
      message: `/acp spawn ${params.agentId} --thread auto`,
      idempotencyKey: `idem-spawn-${randomUUID()}`,
      originatingChannel: "discord",
      originatingTo: params.env.parentChannelId,
      originatingAccountId: params.env.accountId,
    },
  );
  e2eTrace(
    `spawnAcpWithMarker: spawn chat.send returned status=${String(spawnResult?.status)} runId=${String(spawnResult?.runId)}`,
  );
  if (spawnResult?.status !== "started" || typeof spawnResult.runId !== "string") {
    throw new Error(`chat.send for spawn did not start correctly: ${JSON.stringify(spawnResult)}`);
  }
  e2eTrace(`spawnAcpWithMarker: awaiting spawn agent.wait runId=${spawnResult.runId}`);
  await params.gateway.request(
    "agent.wait",
    { runId: spawnResult.runId, timeoutMs: Math.max(30_000, timeoutMs - (Date.now() - startedAt)) },
    { timeoutMs: Math.max(35_000, timeoutMs - (Date.now() - startedAt) + 5_000) },
  );
  e2eTrace("spawnAcpWithMarker: spawn agent.wait completed");

  // Pull history for the main session so we can extract the spawned session key.
  e2eTrace("spawnAcpWithMarker: fetching chat.history for spawned session key");
  const history: { messages?: unknown[] } = await params.gateway.request("chat.history", {
    sessionKey,
    limit: 16,
  });
  const spawnedSessionKey = extractSpawnedAcpSessionKey(history.messages ?? []);
  e2eTrace(`spawnAcpWithMarker: spawnedSessionKey=${String(spawnedSessionKey)}`);
  if (!spawnedSessionKey) {
    // Surface the most recent assistant text so operators can tell whether
    // the failure is "backend unavailable" vs "backend healthy but spawn
    // rejected" vs a transport regression.
    const preview = extractFirstAssistantTextPreview(history.messages ?? []);
    throw new Error(
      `could not extract spawned ACP session key from chat.history${preview ? ` (last assistant text: ${preview})` : ""}`,
    );
  }

  // After bind, drive the ACP session with the task prompt so the child
  // agent produces the marker. The `/acp spawn` command only creates the
  // session; the actual task needs a separate turn on the spawned session
  // key. Without this second turn the child has nothing to echo into the
  // bound Discord thread and findThreadWithMarker below will always time
  // out. We dispatch via `chat.send` on the spawned session key and await
  // completion (best effort — some scenarios want to inspect mid-run state,
  // so we cap the wait here to the remaining budget).
  const taskRemainingMs = Math.max(30_000, timeoutMs - (Date.now() - startedAt));
  e2eTrace(`spawnAcpWithMarker: dispatching task prompt (remainingMs=${taskRemainingMs})`);
  const taskResult: { runId?: string; status?: string } = await params.gateway.request(
    "chat.send",
    {
      sessionKey: spawnedSessionKey,
      message: params.task,
      idempotencyKey: `idem-task-${randomUUID()}`,
      originatingChannel: "discord",
      originatingTo: params.env.parentChannelId,
      originatingAccountId: params.env.accountId,
    },
  );
  e2eTrace(
    `spawnAcpWithMarker: task chat.send status=${String(taskResult?.status)} runId=${String(taskResult?.runId)}`,
  );
  if (taskResult?.status === "started" && typeof taskResult.runId === "string") {
    await params.gateway.request(
      "agent.wait",
      { runId: taskResult.runId, timeoutMs: taskRemainingMs },
      { timeoutMs: taskRemainingMs + 5_000 },
    );
    e2eTrace("spawnAcpWithMarker: task agent.wait completed");
  }

  // Find the newly created thread containing our marker. ACP spawn creates a
  // thread via the Discord extension; we poll until it shows up.
  e2eTrace(`spawnAcpWithMarker: looking for thread with marker ${params.marker}`);
  const threadId = await withDiscordRetry(() =>
    findThreadWithMarker({
      env: params.env,
      marker: params.marker,
      timeoutMs: Math.max(15_000, timeoutMs - (Date.now() - startedAt)),
    }),
  );
  e2eTrace(`spawnAcpWithMarker: found threadId=${threadId}`);

  return { threadId, spawnedSessionKey, requestMessageId };
}

/**
 * Red-team spawn helper: wraps `spawnAcpWithMarker` with an explicit leak
 * payload. The payload is embedded in the task prompt so the child agent
 * observes the leaky string in its context and has the opportunity to echo
 * it back in progress-class output. The MARKER portion MUST survive
 * sanitization (it is deliberately non-leaky); the LEAK portion is what the
 * sanitizer is expected to scrub before the message reaches Discord.
 *
 * Keep this helper thin. It exists so red-team scenarios read like:
 *   const spawn = await spawnAcpWithLeakyPrompt({ ..., leak: "...", marker: "..." });
 *
 * rather than repeating the task-template construction in every scenario.
 */
export async function spawnAcpWithLeakyPrompt(params: {
  agentId: "claude" | "codex";
  marker: string;
  leak: string;
  taskPreamble?: string;
  env: DiscordE2EEnv;
  gateway: GatewayClient;
  gatewayEnv: { port: number; token: string };
  timeoutMs?: number;
}): Promise<{ threadId: string; spawnedSessionKey: string; requestMessageId: string }> {
  const preamble =
    params.taskPreamble ??
    "Summarize what you just saw in one short sentence, then echo back the MARKER verbatim on its own line.";
  // The child sees the leak as context. It may or may not echo it back; the
  // red-team assertion is that IF it echoes the leak as progress-class
  // output, the sanitizer strips it before delivery. The MARKER anchor lets
  // the assertion locate the message.
  const task = [
    preamble,
    "",
    "CONTEXT (do not quote verbatim in your final user-facing reply):",
    params.leak,
    "",
    `MARKER: ${params.marker}`,
  ].join("\n");
  return spawnAcpWithMarker({
    agentId: params.agentId,
    marker: params.marker,
    task,
    env: params.env,
    gateway: params.gateway,
    gatewayEnv: params.gatewayEnv,
    timeoutMs: params.timeoutMs,
  });
}

/**
 * Assert that a leak pattern is absent from the given Discord message content.
 * Optionally also assert that an expected scrubbed form (e.g. `~/tmp/...`,
 * `[redacted]`) IS present to prove the sanitizer rewrote rather than merely
 * swallowed the text.
 *
 * Use this from red-team E2Es after `assertVisibleInThread` returned the
 * relevant message.
 */
export function assertContentScrubbed(
  content: string,
  expectations: {
    leak: string | RegExp;
    expectedScrubbedForm?: string | RegExp;
    label?: string;
  },
): void {
  const label = expectations.label ?? "leak";
  const leakPresent =
    typeof expectations.leak === "string"
      ? content.includes(expectations.leak)
      : expectations.leak.test(content);
  if (leakPresent) {
    const shown = content.length > 400 ? `${content.slice(0, 400)}...` : content;
    throw new Error(
      `assertContentScrubbed[${label}]: leak ${String(
        expectations.leak,
      )} still present in visible content: ${JSON.stringify(shown)}`,
    );
  }
  if (expectations.expectedScrubbedForm !== undefined) {
    const scrubbedPresent =
      typeof expectations.expectedScrubbedForm === "string"
        ? content.includes(expectations.expectedScrubbedForm)
        : expectations.expectedScrubbedForm.test(content);
    if (!scrubbedPresent) {
      const shown = content.length > 400 ? `${content.slice(0, 400)}...` : content;
      throw new Error(
        `assertContentScrubbed[${label}]: expected scrubbed form ${String(
          expectations.expectedScrubbedForm,
        )} missing from content: ${JSON.stringify(shown)}`,
      );
    }
  }
}

/**
 * Scan the recent thread history for any of the provided leak patterns.
 * Mirrors `assertNoForbiddenChatter` but for secret-shaped content. Useful
 * as a blanket red-team safety net in addition to message-specific
 * `assertContentScrubbed` calls.
 */
export async function assertNoLeaksInThread(params: {
  threadId: string;
  env: DiscordE2EEnv;
  scanLimit?: number;
  leaks?: readonly (string | RegExp)[];
}): Promise<void> {
  const scanLimit = Math.max(1, Math.min(params.scanLimit ?? 50, 100));
  const leaks = params.leaks ?? LEAK_PATTERNS_DEFAULT;
  const messages = await withDiscordRetry(() =>
    readThreadMessages(params.env, params.threadId, scanLimit),
  );
  const violations: Array<{ messageId: string; pattern: string; content: string }> = [];
  for (const msg of messages) {
    const content = msg.content ?? "";
    for (const pattern of leaks) {
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
      `assertNoLeaksInThread: ${String(violations.length)} leak pattern hit(s) in thread ${
        params.threadId
      }:\n${summary}`,
    );
  }
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
 * Rebind an existing parent session to a new thread (Phase 7 P2 scenario 10).
 * Creates a new public thread in the secondary channel and issues a bind
 * RPC to point the existing parent session at it.
 *
 * Requires `env.secondaryChannelId` (or an explicit `newParentChannelId`) so
 * the new thread lives in a channel DIFFERENT from the original binding.
 * Without a secondary channel the scenario cannot prove "different channel"
 * — it would just create a sibling thread under the same parent. The mid-run
 * rebinding contract is specifically about moving parent -> different
 * channel, so we fail loudly if the env is incomplete.
 */
export async function rebindParentToNewThread(params: {
  parentSessionKey: string;
  newParentChannelId?: string;
  env: DiscordE2EEnv;
  gateway: GatewayClient;
}): Promise<{ newThreadId: string; newParentChannelId: string }> {
  const newParentChannelId = params.newParentChannelId ?? params.env.secondaryChannelId;
  if (!newParentChannelId) {
    throw new Error(
      "rebindParentToNewThread: missing newParentChannelId and env.secondaryChannelId; set OPENCLAW_LIVE_DISCORD_SECONDARY_CHANNEL_ID or pass newParentChannelId",
    );
  }
  const thread = await withDiscordRetry(() =>
    createDiscordThread(params.env, newParentChannelId, {
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
  return { newThreadId: threadId, newParentChannelId };
}

/**
 * Archive a Discord thread (public helper for Phase 7 P2 scenario 9).
 *
 * Unlike `cleanupBinding` (which swallows errors because cleanup is
 * best-effort), this helper surfaces failures so the archived-thread
 * recovery scenario can tell the difference between "archive failed" and
 * "archive succeeded but Phase 11 respawn did not fire".
 */
export async function archiveThreadDiscord(params: {
  threadId: string;
  env: DiscordE2EEnv;
  locked?: boolean;
}): Promise<void> {
  await withDiscordRetry(() =>
    archiveThreadRaw(params.env, params.threadId, { locked: params.locked === true }),
  );
}

/**
 * List every active thread under the configured parent channel. Used by
 * Phase 7 P2 scenario 9 (archived-thread recovery) to discover a NEW thread
 * that the Phase 11 respawn path creates after the original is archived.
 */
export async function listActiveThreadsInParent(params: {
  env: DiscordE2EEnv;
  parentChannelId?: string;
}): Promise<Array<{ id: string; parent_id?: string; name?: string }>> {
  const parentChannelId = params.parentChannelId ?? params.env.parentChannelId;
  const rest = getRestClient(params.env.botToken);
  const active = (await rest.get(Routes.guildActiveThreads(params.env.guildId))) as {
    threads?: Array<{ id: string; parent_id?: string; name?: string }>;
  };
  const threads = active.threads ?? [];
  return threads.filter((t) => !t.parent_id || t.parent_id === parentChannelId);
}

/**
 * Wait for the marker to appear in a NEW thread after `excludeThreadId`
 * was archived. This is the assertion for Phase 11 respawn: after we
 * archive the original bound thread, the child agent's next emission must
 * cause the gateway to create a fresh thread and deliver there.
 *
 * Returns the new thread id and the matching message. Throws if no new
 * thread with the marker appears within `timeoutMs`.
 */
export async function waitForMarkerInNewThread(params: {
  env: DiscordE2EEnv;
  marker: string;
  excludeThreadId: string;
  parentChannelId?: string;
  timeoutMs?: number;
}): Promise<{ newThreadId: string; message: APIMessage }> {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const threads = await withDiscordRetry(() =>
      listActiveThreadsInParent({ env: params.env, parentChannelId: params.parentChannelId }),
    );
    for (const thread of threads) {
      if (thread.id === params.excludeThreadId) {
        continue;
      }
      try {
        const messages = await withDiscordRetry(() =>
          readThreadMessages(params.env, thread.id, 25),
        );
        const match = messages.find((m) => m.content?.includes(params.marker));
        if (match) {
          return { newThreadId: thread.id, message: match };
        }
      } catch {
        // Skip threads we cannot read (e.g. just archived by a racing test).
      }
    }
    const jitter = 300 + Math.floor(Math.random() * 700);
    await sleep(1_500 + jitter);
  }
  throw new Error(
    `waitForMarkerInNewThread: marker ${JSON.stringify(params.marker)} not seen in any thread other than ${params.excludeThreadId} within ${String(timeoutMs)}ms`,
  );
}

/**
 * Trigger an emission in the bound session without expecting a new
 * delivery (best-effort nudge used by scenarios that archive the bound
 * thread mid-run). Returns after the nudge's chat.send resolves — we do
 * NOT wait on `agent.wait` because after archival the runner's next post
 * is the interesting side-effect, not the ack.
 */
export async function nudgeBoundSession(params: {
  spawnedSessionKey: string;
  text: string;
  boundTarget: string;
  env: DiscordE2EEnv;
  gateway: GatewayClient;
}): Promise<void> {
  await params.gateway.request("chat.send", {
    sessionKey: params.spawnedSessionKey,
    message: params.text,
    idempotencyKey: `idem-nudge-${randomUUID()}`,
    originatingChannel: "discord",
    originatingTo: params.boundTarget,
    originatingAccountId: params.env.accountId,
  });
}

/**
 * Raw read of the most recent messages in a Discord thread / channel.
 * Unlike `assertVisibleInThread` this helper does not assert anything —
 * it just returns whatever REST returns. Used by Scenario 10 to run a
 * NEGATIVE control ("marker2 must NOT appear in the old thread") which
 * cannot be expressed via the assertion helpers.
 */
export async function readMessagesInThread(params: {
  threadId: string;
  env: DiscordE2EEnv;
  limit?: number;
}): Promise<APIMessage[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
  return withDiscordRetry(() => readThreadMessages(params.env, params.threadId, limit));
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
  await archiveThreadRaw(env, threadId, { locked: false });
}

async function archiveThreadRaw(
  env: DiscordE2EEnv,
  threadId: string,
  opts: { locked: boolean },
): Promise<void> {
  const rest = getRestClient(env.botToken);
  await rest.patch(Routes.channel(threadId), {
    body: { archived: true, locked: opts.locked },
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
  let pollAttempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    pollAttempt += 1;
    const active = (await rest.get(Routes.guildActiveThreads(env.guildId))) as {
      threads?: Array<{ id: string; parent_id?: string; name?: string }>;
    };
    const threads = active.threads ?? [];
    const candidateThreads = threads.filter(
      (t) => !t.parent_id || t.parent_id === env.parentChannelId,
    );
    // Log candidate threads periodically (every 10 polls plus first two)
    // so operators can see progress without drowning logs.
    if (pollAttempt <= 2 || pollAttempt % 10 === 0) {
      e2eTrace(
        `findThreadWithMarker poll=${pollAttempt}: ${threads.length} active thread(s), ${candidateThreads.length} under parent ${env.parentChannelId}; names=${JSON.stringify(candidateThreads.map((t) => t.name ?? t.id))}`,
      );
    }
    for (const thread of candidateThreads) {
      // Scan the thread's messages for the marker.
      const messages = (await rest.get(Routes.channelMessages(thread.id), {
        limit: 25,
      })) as APIMessage[];
      if (messages.some((msg) => msg.content?.includes(marker))) {
        e2eTrace(`findThreadWithMarker: matched thread ${thread.id} (${thread.name ?? ""})`);
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

/**
 * Pull the first assistant text chunk out of a chat.history response so
 * `spawnAcpWithMarker` can surface diagnostic context when the Spawned-ACP
 * session line is missing. Keeps us from debugging blind against
 * `ACP_BACKEND_UNAVAILABLE` vs genuine transport failures.
 */
function extractFirstAssistantTextPreview(messages: unknown[]): string | null {
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const role = (entry as { role?: unknown }).role;
    if (role !== "assistant") {
      continue;
    }
    const content = (entry as { content?: unknown }).content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim().length > 0) {
          const trimmed = text.trim();
          return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
        }
      }
    }
  }
  return null;
}

/**
 * Wait until the acpx runtime backend reports healthy. The acpx plugin
 * registers its backend synchronously during plugin startup, but the
 * `probeAvailability()` call that flips `healthy()` from false to true runs
 * asynchronously. A test that spawns immediately after gateway startup can
 * lose that race and see `ACP_BACKEND_UNAVAILABLE`, which surfaces here as
 * "could not extract spawned ACP session key from chat.history".
 *
 * We mirror the approach in `src/gateway/gateway-acp-bind.live.test.ts`:
 * look up the acpx backend, explicitly drive `probeAvailability()` until
 * `healthy()` returns true, retrying with backoff until `timeoutMs` elapses.
 *
 * Kept in the harness (not in production) because the retry is a test-only
 * expectation: real gateway clients should not be driving lifecycle probes.
 */
async function waitForAcpBackendHealthy(params: { timeoutMs: number }): Promise<void> {
  const timeoutMs = Math.max(1_000, params.timeoutMs);
  const startedAt = Date.now();
  // Lazy import so module consumers in non-test contexts do not pay the
  // registry import cost.
  const { getAcpRuntimeBackend } = await import("../../acp/runtime/registry.js");
  let lastError: unknown;
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      e2eTrace(`waitForAcpBackendHealthy: acpx backend not yet registered (attempt ${attempt})`);
      await sleep(500);
      continue;
    }
    if (backend.healthy?.()) {
      e2eTrace(`waitForAcpBackendHealthy: backend healthy after ${attempt} attempt(s)`);
      return;
    }
    const runtime = backend.runtime as { probeAvailability?: () => Promise<void> } | undefined;
    if (runtime?.probeAvailability) {
      try {
        await runtime.probeAvailability();
      } catch (err) {
        lastError = err;
        e2eTrace(
          `waitForAcpBackendHealthy: probeAvailability threw (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (backend.healthy?.()) {
      e2eTrace(`waitForAcpBackendHealthy: backend healthy after probe (attempt ${attempt})`);
      return;
    }
    e2eTrace(`waitForAcpBackendHealthy: still not healthy after attempt ${attempt}`);
    await sleep(1_500 + Math.floor(Math.random() * 500));
  }
  const detail =
    lastError instanceof Error
      ? `: ${lastError.message}`
      : typeof lastError === "string" && lastError.length > 0
        ? `: ${lastError}`
        : lastError !== undefined && lastError !== null
          ? `: ${JSON.stringify(lastError)}`
          : "";
  throw new Error(
    `waitForAcpBackendHealthy: acpx backend did not become healthy within ${String(timeoutMs)}ms${detail}`,
  );
}
