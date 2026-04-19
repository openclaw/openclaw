import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
 * Minimal external auth directories the harness copies from the real HOME
 * into the tempRoot so the spawned ACP child sees Claude Code / Codex CLI
 * credentials. Mirrors the canonical `LIVE_EXTERNAL_AUTH_DIRS` list from
 * `test/test-env.ts` but scoped to just what Discord E2E needs — we do NOT
 * copy `.gemini` / `.minimax` because the live suite only spawns the two
 * agents currently configured for the bound-thread flow.
 *
 * Keep this list in sync with the set of agents the harness actually spawns.
 * Production auth layouts under `~/.claude` / `~/.codex` can contain large
 * session history trees; we recursively copy the whole directory so auth
 * probes that read sibling files (token store, mcp config) still work.
 */
export const HARNESS_AUTH_DIRS = [".claude", ".codex"] as const;

/**
 * Optional dotfiles the harness also copies alongside the auth dirs. Mirrors
 * `LIVE_EXTERNAL_AUTH_FILES` in `test/test-env.ts`. Kept separate so the dir
 * copy helpers do not try to `cpSync(dir, file)`.
 */
export const HARNESS_AUTH_FILES = [".claude.json"] as const;

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

  // Snapshot the set of active threads under the parent channel BEFORE the
  // spawn. After the gateway creates the bound thread we diff against this
  // snapshot to discover the new thread id deterministically — without
  // relying on banner text matching, which is brittle when the banner runs
  // through the sanitizer or channel rate-limits the REST read.
  e2eTrace("spawnAcpWithMarker: snapshotting active threads (pre-spawn)");
  const preSpawnThreads = await withDiscordRetry(() =>
    listActiveThreadsInParent({ env: params.env }),
  );
  const preSpawnThreadIds = new Set(preSpawnThreads.map((t) => t.id));
  e2eTrace(`spawnAcpWithMarker: pre-spawn active thread count=${preSpawnThreadIds.size}`);

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

  // Discover the bound thread id by diffing the active-threads list against
  // the pre-spawn snapshot. The gateway creates at most one new thread per
  // `--thread auto` spawn under this parent, so the single new entry is the
  // one we want. We poll briefly because REST sees thread creation slightly
  // after the spawn RPC resolves.
  e2eTrace("spawnAcpWithMarker: discovering bound thread id via snapshot diff");
  const discoverDeadlineMs = Date.now() + Math.max(15_000, Math.min(30_000, timeoutMs / 4));
  let threadId: string | undefined;
  while (Date.now() < discoverDeadlineMs) {
    const nowThreads = await withDiscordRetry(() => listActiveThreadsInParent({ env: params.env }));
    const candidates = nowThreads.filter((t) => !preSpawnThreadIds.has(t.id));
    if (candidates.length === 1) {
      threadId = candidates[0]?.id;
      break;
    }
    if (candidates.length > 1) {
      // Multiple new threads is unexpected; prefer the most recent name
      // starting with the spawn's agent id if present, else fail loudly so
      // operators notice the ambiguity.
      const match = candidates.find((t) => (t.name ?? "").toLowerCase().includes(params.agentId));
      if (match) {
        threadId = match.id;
        break;
      }
      throw new Error(
        `spawnAcpWithMarker: ambiguous new threads after spawn (${String(
          candidates.length,
        )} candidates): ${JSON.stringify(candidates.map((t) => ({ id: t.id, name: t.name })))}`,
      );
    }
    await sleep(500);
  }
  if (!threadId) {
    throw new Error(
      `spawnAcpWithMarker: no new thread appeared under parent ${params.env.parentChannelId} within ${String(
        Math.round((discoverDeadlineMs - startedAt) / 1000),
      )}s of spawn completing`,
    );
  }
  e2eTrace(`spawnAcpWithMarker: discovered bound threadId=${threadId}`);

  // The spawn RPC's agent.wait guarantees the bind step completed before
  // we reach here, so the binding record for the new thread id should be
  // in state. We intentionally do NOT deep-import the Discord extension's
  // binding manager from this core helper (extension boundary rule): the
  // binding is exercised implicitly when the native message below resolves
  // a bound session via preflight. If the binding were absent, the ACP
  // turn would fall back to an unbound session and the marker would not
  // reach the thread — which the assertion at the end of this helper
  // surfaces as a clear timeout failure.

  // Drive the child's first real turn as a NATIVE Discord message posted
  // into the bound thread. Because the harness bot shares its token with the
  // gateway, the self-filter bypass (gated by OPENCLAW_E2E_ALLOW_SELF_MESSAGES
  // + NODE_ENV!=="production") allows the resulting MessageCreate event to
  // reach preflightDiscordMessage, which resolves the session via the Phase 11
  // thread-binding lookup. The ctx then carries Discord provenance +
  // MessageThreadId, so dispatch-acp-delivery routes the child's final_reply
  // back through the webhook path into the same thread.
  const taskContent = `${params.task}\n\nEcho the following token verbatim on its own line at the end of your reply: ${params.marker}`;
  e2eTrace(`spawnAcpWithMarker: posting native-origin task message into thread ${threadId}`);
  const request = await withDiscordRetry(() =>
    postDiscordMessage(params.env, threadId, taskContent),
  );
  const requestMessageId = request.id;
  e2eTrace(`spawnAcpWithMarker: task message posted id=${requestMessageId}`);

  // Wait for the marker to show up in the bound thread. This is the merge
  // gate: the marker reaching the thread proves the whole delivery chain
  // (inbound self-bypass -> preflight -> bound-session resolution -> ACP
  // dispatch -> webhook outbound) works end-to-end against live Discord.
  //
  // IMPORTANT: we EXCLUDE the harness request message id from the scan so
  // the helper cannot mistake its own prompt-echo for the assistant reply.
  // Without this exclusion the scan matches the request message (which
  // contains the marker verbatim) and succeeds before any webhook reply
  // actually lands — the exact Task-2 false-positive.
  e2eTrace(`spawnAcpWithMarker: waiting for marker ${params.marker} in thread ${threadId}`);
  await withDiscordRetry(() =>
    findThreadWithMarker({
      env: params.env,
      marker: params.marker,
      timeoutMs: Math.max(15_000, timeoutMs - (Date.now() - startedAt)),
      expectedThreadId: threadId,
      excludeMessageIds: [requestMessageId],
    }),
  );
  e2eTrace(`spawnAcpWithMarker: marker seen in threadId=${threadId}`);

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
 * Options for exclusion-aware thread scans.
 *
 * Red-team scenarios embed the leak string or forbidden phrase in the
 * harness request message so the child has an opportunity to echo it
 * back. Without exclusion the scan flags the prompt itself and the test
 * fails for harness reasons. Use `excludeMessageIds: [requestMessageId]`
 * OR `authorship: "webhook-only"` (or both) to measure only the
 * assistant-delivered content. See Task 3 of
 * docs/superpowers/plans/2026-04-18-discord-surface-overhaul-master-handoff.md.
 */
export type ThreadScanOptions = {
  excludeMessageIds?: readonly string[];
  authorship?: "any" | "webhook-only";
};

/**
 * Scan the recent thread history for any of the provided leak patterns.
 * Mirrors `assertNoForbiddenChatter` but for secret-shaped content. Useful
 * as a blanket red-team safety net in addition to message-specific
 * `assertContentScrubbed` calls.
 *
 * Defaults to `authorship: "any"` so generic cleanup scans still catch
 * leaks regardless of authorship. Red-team scenarios should opt into
 * `webhook-only` or pass `excludeMessageIds: [requestMessageId]` so the
 * harness prompt does not contaminate the result.
 */
export async function assertNoLeaksInThread(
  params: {
    threadId: string;
    env: DiscordE2EEnv;
    scanLimit?: number;
    leaks?: readonly (string | RegExp)[];
  } & ThreadScanOptions,
): Promise<void> {
  const scanLimit = Math.max(1, Math.min(params.scanLimit ?? 50, 100));
  const leaks = params.leaks ?? LEAK_PATTERNS_DEFAULT;
  const excluded = new Set(params.excludeMessageIds ?? []);
  const webhookOnly = params.authorship === "webhook-only";
  const messages = await withDiscordRetry(() =>
    readThreadMessages(params.env, params.threadId, scanLimit),
  );
  const violations: Array<{ messageId: string; pattern: string; content: string }> = [];
  for (const msg of messages) {
    if (excluded.has(msg.id)) {
      continue;
    }
    if (webhookOnly && msg.webhook_id == null) {
      continue;
    }
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
 * Options for strict marker-visibility scans.
 *
 * - `excludeMessageIds`: ignore these message ids entirely when scanning for
 *   the marker. The harness passes its own `requestMessageId` here so the
 *   helper cannot mistake its own prompt for an assistant reply.
 * - `requireWebhookAuthor`: when true (default), a match only counts if the
 *   message has `webhook_id` set (i.e. was delivered via the bound webhook).
 *   Non-webhook matches are ignored. Set `false` for explicit callers that
 *   do not care about authorship.
 * - `allowDiagnosticFallback`: when true, and no webhook match arrives
 *   before the timeout, return the earliest non-webhook match so operators
 *   can triage "saw a match but not a webhook one" vs "saw nothing". Default
 *   is false: strict mode throws rather than silently falling back.
 */
export type MarkerVisibilityOptions = {
  excludeMessageIds?: readonly string[];
  requireWebhookAuthor?: boolean;
  allowDiagnosticFallback?: boolean;
};

/**
 * Assert that a marker string appears in visible thread messages.
 *
 * Uses jittered backoff polling so we absorb Discord REST propagation delay.
 * Returns the matched message for further assertions (author identity, etc).
 *
 * STRICT DEFAULTS (see `MarkerVisibilityOptions`):
 *   - requireWebhookAuthor: true   (only webhook-authored messages count)
 *   - allowDiagnosticFallback: false (no silent fallback on timeout)
 *
 * Callers SHOULD pass `excludeMessageIds: [requestMessageId]` so the
 * harness's own request message cannot be mistaken for an assistant reply.
 * This is the core Task-2 fix: without the exclusion, the harness can
 * satisfy its own assertion in the exact failure mode "thread exists,
 * banner exists, assistant reply missing".
 */
export async function assertVisibleInThread(
  params: {
    threadId: string;
    marker: string;
    env: DiscordE2EEnv;
    timeoutMs?: number;
    minCount?: number;
  } & MarkerVisibilityOptions,
): Promise<APIMessage> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const minCount = Math.max(1, params.minCount ?? 1);
  const requireWebhookAuthor = params.requireWebhookAuthor ?? true;
  const allowDiagnosticFallback = params.allowDiagnosticFallback ?? false;
  const excluded = new Set(params.excludeMessageIds ?? []);
  const startedAt = Date.now();
  let lastMessages: APIMessage[] = [];
  let lastNonWebhookMatches: APIMessage[] = [];
  const byTimestamp = (a: APIMessage, b: APIMessage) => (a.timestamp < b.timestamp ? -1 : 1);
  // Poll until we find a qualifying match (webhook-authored under strict
  // defaults; any non-excluded match when requireWebhookAuthor=false) or the
  // timeout expires. The harness posts the user's task message containing
  // the marker BEFORE the child's webhook reply; without the exclusion list
  // the request message can be mistaken for the assistant reply and satisfy
  // the assertion silently. See Task 2 in
  // docs/superpowers/plans/2026-04-18-discord-surface-overhaul-master-handoff.md.
  while (Date.now() - startedAt < timeoutMs) {
    lastMessages = await withDiscordRetry(() =>
      readThreadMessages(params.env, params.threadId, 50),
    );
    const matches = lastMessages.filter(
      (msg) => !excluded.has(msg.id) && msg.content?.includes(params.marker),
    );
    if (!requireWebhookAuthor) {
      // Authorship-agnostic mode: return the earliest non-excluded match.
      if (matches.length >= minCount) {
        const ordered = matches.toSorted(byTimestamp);
        const first = ordered[0];
        if (first) {
          return first;
        }
      }
    } else {
      const webhookMatches = matches.filter((msg) => msg.webhook_id != null);
      if (webhookMatches.length >= minCount) {
        const ordered = webhookMatches.toSorted(byTimestamp);
        const first = ordered[0];
        if (!first) {
          throw new Error("webhook matches list empty after sort");
        }
        return first;
      }
      // Remember non-webhook matches so we can fall back on timeout
      // without an extra REST round-trip — but ONLY if the caller has
      // explicitly opted into the diagnostic fallback. Default behavior
      // is to throw at timeout rather than silently accept a non-webhook
      // match.
      if (matches.length >= minCount) {
        lastNonWebhookMatches = matches;
      }
    }
    const jitter = 250 + Math.floor(Math.random() * 500);
    await sleep(1_000 + jitter);
  }
  // Timeout reached without a webhook match. Emit a diagnostic trace so
  // operators can distinguish "no webhook reply at all" from "webhook reply
  // arrived but without the marker".
  const allWebhookMsgs = lastMessages.filter((msg) => msg.webhook_id != null);
  if (allWebhookMsgs.length === 0) {
    e2eTrace(
      `assertVisibleInThread FALLBACK: 0 webhook messages in thread ${params.threadId} — child reply was never emitted via webhook`,
    );
  } else {
    const previews = allWebhookMsgs.map((m) => ({
      id: m.id,
      webhookId: m.webhook_id,
      author: m.author?.username,
      hasMarker: m.content?.includes(params.marker) ?? false,
      preview: (m.content ?? "").slice(0, 120),
    }));
    e2eTrace(
      `assertVisibleInThread FALLBACK: ${String(allWebhookMsgs.length)} webhook message(s) found but none contain marker ${JSON.stringify(params.marker)}: ${JSON.stringify(previews)}`,
    );
  }

  // Diagnostic fallback: only if explicitly opted in. We still honor
  // excludeMessageIds here so a request-id echo of the marker NEVER counts
  // as visible proof, even in fallback mode.
  if (allowDiagnosticFallback && lastNonWebhookMatches.length >= minCount) {
    const ordered = lastNonWebhookMatches.toSorted(byTimestamp);
    const first = ordered[0];
    if (first) {
      return first;
    }
  }
  const suffix = requireWebhookAuthor
    ? ` (no webhook-authored match; non-webhook matches=${String(lastNonWebhookMatches.length)}${
        allowDiagnosticFallback ? " but diagnostic fallback produced nothing" : ""
      })`
    : "";
  throw new Error(
    `assertVisibleInThread: marker ${JSON.stringify(params.marker)} not seen in thread ${
      params.threadId
    } within ${String(timeoutMs)}ms (saw ${String(lastMessages.length)} messages)${suffix}`,
  );
}

/**
 * Assert that none of the forbidden patterns appear in a thread.
 * Scans the most recent N messages (default 50).
 *
 * Defaults to `authorship: "any"` so generic cleanup scans still catch
 * chatter regardless of authorship. Red-team scenarios should opt into
 * `webhook-only` or pass `excludeMessageIds: [requestMessageId]` so the
 * harness prompt does not contaminate the result. See Task 3 of
 * docs/superpowers/plans/2026-04-18-discord-surface-overhaul-master-handoff.md.
 */
export async function assertNoForbiddenChatter(
  params: {
    threadId: string;
    env: DiscordE2EEnv;
    scanLimit?: number;
    forbidden?: readonly (string | RegExp)[];
  } & ThreadScanOptions,
): Promise<void> {
  const scanLimit = Math.max(1, Math.min(params.scanLimit ?? 50, 100));
  const forbidden = params.forbidden ?? FORBIDDEN_CHATTER_DEFAULT;
  const excluded = new Set(params.excludeMessageIds ?? []);
  const webhookOnly = params.authorship === "webhook-only";
  const messages = await withDiscordRetry(() =>
    readThreadMessages(params.env, params.threadId, scanLimit),
  );
  const violations: Array<{ messageId: string; pattern: string; content: string }> = [];
  for (const msg of messages) {
    if (excluded.has(msg.id)) {
      continue;
    }
    if (webhookOnly && msg.webhook_id == null) {
      continue;
    }
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
  /**
   * If provided, only scan this specific thread id. Used by
   * `spawnAcpWithMarker` once the bound thread has already been discovered
   * via snapshot-diff so we don't re-scan unrelated threads and race their
   * markers. Callers that want the original discovery-via-scan behavior can
   * simply omit this field.
   */
  expectedThreadId?: string;
  /**
   * Message ids that MUST NOT count as a marker match. `spawnAcpWithMarker`
   * passes its own `requestMessageId` here so a match on the harness prompt
   * cannot satisfy the "marker reached the thread" wait condition. Without
   * this guard the wait resolves before the assistant reply actually lands.
   */
  excludeMessageIds?: readonly string[];
}): Promise<string> {
  const { env, marker, timeoutMs, expectedThreadId } = params;
  const excluded = new Set(params.excludeMessageIds ?? []);
  const startedAt = Date.now();
  const rest = getRestClient(env.botToken);
  let pollAttempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    pollAttempt += 1;
    let candidateThreads: Array<{ id: string; parent_id?: string; name?: string }>;
    if (expectedThreadId) {
      candidateThreads = [{ id: expectedThreadId }];
    } else {
      const active = (await rest.get(Routes.guildActiveThreads(env.guildId))) as {
        threads?: Array<{ id: string; parent_id?: string; name?: string }>;
      };
      const threads = active.threads ?? [];
      candidateThreads = threads.filter((t) => !t.parent_id || t.parent_id === env.parentChannelId);
    }
    // Log candidate threads periodically (every 10 polls plus first two)
    // so operators can see progress without drowning logs.
    if (pollAttempt <= 2 || pollAttempt % 10 === 0) {
      e2eTrace(
        `findThreadWithMarker poll=${pollAttempt}: scanning ${candidateThreads.length} thread(s)${
          expectedThreadId
            ? ` (pinned to ${expectedThreadId})`
            : ` under parent ${env.parentChannelId}`
        }; names=${JSON.stringify(candidateThreads.map((t) => t.name ?? t.id))}`,
      );
    }
    for (const thread of candidateThreads) {
      // Scan the thread's messages for the marker, honoring the
      // excludeMessageIds guard so the harness's own request echo does
      // not satisfy the wait.
      const messages = (await rest.get(Routes.channelMessages(thread.id), {
        limit: 25,
      })) as APIMessage[];
      if (messages.some((msg) => !excluded.has(msg.id) && msg.content?.includes(marker))) {
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

// --- Harness isolation (Task 5) ----------------------------------------------
//
// The live Discord E2E harness used to spawn ACP children without isolating
// HOME or providing a sane CWD. That meant the child wrote into the real
// production session dirs under `~/.openclaw/agents/*` AND operated out of
// an empty temp workspace where Claude Code / Codex CLI silently no-op.
// Source of analysis:
//   /home/richard/repos/shared-memory/main/lesson-e2e-harness-isolation-gap-2026-04-18.md
//
// The helpers below implement code-side isolation only. They do NOT change
// guild membership, pause production accounts, or alter production bot
// participation. Those remain an ops prerequisite documented in
// `src/infra/outbound/discord-surface.e2e.test.ts` above `withLiveHarness`.

/**
 * Default CWD the harness should pass to spawned ACP child sessions. Prefer
 * the repo root because the ACP agents (Claude Code, Codex) load `CLAUDE.md`
 * + `package.json` signals on spawn; pointing them at an empty tempdir makes
 * them silently no-op. Falls back to a minimal workspace under `<tempRoot>`
 * only when the repo root does not exist (e.g. on a detached test runner).
 */
export function resolveHarnessAgentCwd(params: { tempRoot: string; repoRoot?: string }): string {
  const preferredRepoRoot = params.repoRoot ?? "/home/richard/repos/openclaw-source";
  try {
    const stat = fs.statSync(preferredRepoRoot);
    if (stat.isDirectory()) {
      // Verify the directory is recognizable as a repo root so we do not
      // accidentally point the child at an unrelated path. Any of these is
      // sufficient evidence that the spawned agent will see a real workspace.
      for (const marker of ["package.json", "CLAUDE.md", ".git"]) {
        if (fs.existsSync(path.join(preferredRepoRoot, marker))) {
          return preferredRepoRoot;
        }
      }
    }
  } catch {
    // fall through to fallback workspace
  }
  // Fallback: prepare a minimal workspace so the child has at least a
  // package.json + CLAUDE.md to anchor on. This is strictly a worst-case
  // path — the repo-root preference above should hit in every supported
  // environment.
  const fallback = path.join(params.tempRoot, "workspace");
  fs.mkdirSync(fallback, { recursive: true });
  const stub = path.join(fallback, "package.json");
  if (!fs.existsSync(stub)) {
    fs.writeFileSync(
      stub,
      `${JSON.stringify(
        { name: "openclaw-discord-e2e-fallback-workspace", private: true, version: "0.0.0" },
        null,
        2,
      )}\n`,
    );
  }
  const claudeMd = path.join(fallback, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(
      claudeMd,
      "# openclaw live Discord E2E harness fallback workspace\n\n" +
        "This directory exists only because the harness could not locate\n" +
        "the real repo root. Delete it after the run completes.\n",
    );
  }
  return fallback;
}

/**
 * Copy the minimal set of external auth directories/files from `realHome`
 * into `tempHome`. Quietly skips entries that do not exist on the host.
 *
 * Mirrors the `LIVE_EXTERNAL_AUTH_DIRS` + `LIVE_EXTERNAL_AUTH_FILES` pattern
 * from `test/test-env.ts` so harness isolation matches the rest of the live
 * test infra. Kept here (rather than reaching into `test/test-env.ts`) so the
 * helper stays usable from this core-adjacent test surface without pulling
 * the whole `installTestEnv` machinery into the Discord harness.
 */
export function copyHarnessAuthDirs(params: {
  realHome: string;
  tempHome: string;
  authDirs?: readonly string[];
  authFiles?: readonly string[];
}): { copiedDirs: string[]; copiedFiles: string[] } {
  const dirs = params.authDirs ?? HARNESS_AUTH_DIRS;
  const files = params.authFiles ?? HARNESS_AUTH_FILES;
  const copiedDirs: string[] = [];
  const copiedFiles: string[] = [];
  for (const dirName of dirs) {
    const src = path.join(params.realHome, dirName);
    const dst = path.join(params.tempHome, dirName);
    if (!fs.existsSync(src)) {
      continue;
    }
    try {
      const stat = fs.statSync(src);
      if (!stat.isDirectory()) {
        continue;
      }
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(src, dst, { recursive: true, force: true });
      copiedDirs.push(dirName);
    } catch (err) {
      // Auth copy is best-effort: a missing sub-file should not abort the
      // whole harness run. Surface a trace so operators can diagnose later.
      e2eTrace(
        `copyHarnessAuthDirs: failed to copy ${dirName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const fileName of files) {
    const src = path.join(params.realHome, fileName);
    const dst = path.join(params.tempHome, fileName);
    if (!fs.existsSync(src)) {
      continue;
    }
    try {
      const stat = fs.statSync(src);
      if (!stat.isFile()) {
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copiedFiles.push(fileName);
    } catch (err) {
      e2eTrace(
        `copyHarnessAuthDirs: failed to copy ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { copiedDirs, copiedFiles };
}

/**
 * Context returned by `installHarnessIsolation`. Callers MUST invoke
 * `restore()` in their finally block or the real HOME environment variable
 * will leak the temp path across subsequent tests.
 */
export interface HarnessIsolationContext {
  /** The temp HOME directory the harness writes into. */
  tempHome: string;
  /** The real HOME this isolation replaced (for diagnostics only). */
  realHome: string;
  /** CWD the harness should pass to spawned ACP child sessions. */
  agentCwd: string;
  /** Names of auth directories that were actually copied. */
  copiedAuthDirs: string[];
  /** Names of auth files that were actually copied. */
  copiedAuthFiles: string[];
  /** Restore the original HOME + USERPROFILE. Idempotent. */
  restore: () => void;
}

/**
 * Install HOME isolation + prepare a sane CWD for the live Discord E2E
 * harness. This is the Task-5 entrypoint; every `withLiveHarness` run must
 * call this helper so:
 *
 *   1. The spawned ACP child cannot write into the real production session
 *      tree under the developer's home directory (prevents state bleed).
 *   2. Claude Code / Codex CLI see their usual auth tree under the paths
 *      `<tempHome>/.claude` and `<tempHome>/.codex`.
 *   3. The child agent CWD is a real repo root (or a prepared minimal
 *      workspace fallback) so package.json / CLAUDE.md lookups succeed.
 *
 * The returned `restore()` MUST be invoked in the caller's finally block.
 * Doing so in a `try/finally` around a single describe/it covers both happy
 * and error paths.
 */
export function installHarnessIsolation(params: {
  tempRoot: string;
  realHome?: string;
  authDirs?: readonly string[];
  authFiles?: readonly string[];
  repoRoot?: string;
}): HarnessIsolationContext {
  const realHome = params.realHome ?? process.env.HOME ?? "";
  const tempHome = params.tempRoot;
  fs.mkdirSync(tempHome, { recursive: true });

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  const copyResult = realHome
    ? copyHarnessAuthDirs({
        realHome,
        tempHome,
        authDirs: params.authDirs,
        authFiles: params.authFiles,
      })
    : { copiedDirs: [], copiedFiles: [] };

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  const agentCwd = resolveHarnessAgentCwd({
    tempRoot: tempHome,
    repoRoot: params.repoRoot,
  });

  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  };

  return {
    tempHome,
    realHome,
    agentCwd,
    copiedAuthDirs: copyResult.copiedDirs,
    copiedAuthFiles: copyResult.copiedFiles,
    restore,
  };
}
