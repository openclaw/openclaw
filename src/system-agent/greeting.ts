// Cached, model-phrased caretaker greetings over deterministic gateway facts.
import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SystemAgentChatQuestion } from "../../packages/gateway-protocol/src/index.js";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { CONFIG_AUDIT_SCOPE, type ConfigAuditRecord } from "../config/io.audit.js";
import type { HealthSummary } from "../gateway/health/types.js";
import { getHealthCache } from "../gateway/server/health-state.js";
import {
  createSqliteAuditRecordReader,
  createSqliteAuditRecordWriter,
} from "../infra/sqlite-audit-record-store.async.js";
import { getUpdateAvailable, type UpdateAvailable } from "../infra/update-status-state.js";
import { formatSystemAgentStartupMessage, type SystemAgentOverview } from "./overview.js";

const SYSTEM_AGENT_GREETING_SCOPE = "system-agent-greeting";
const SYSTEM_AGENT_GREETING_KEY = "latest";
const SYSTEM_AGENT_GREETING_TIMEOUT_MS = 20_000;
const SYSTEM_AGENT_GREETING_FAILURE_RETRY_MS = 60_000;
const SYSTEM_AGENT_GREETING_MAX_CHARS = 700;
const SYSTEM_AGENT_GREETING_MAX_LINES = 5;
const GREETING_STATE_CAS_ATTEMPTS = 4;

export type SystemAgentGreetingFacts = {
  updateAvailable: string | null;
  channelHealth: { available: boolean; degraded: string[] };
  recentExternalEdit: boolean;
  /** Newest config-audit sequence observed while these facts were built. */
  auditSequence: number;
};

export type SystemAgentGreetingCacheRecord = {
  lastSeenAuditSequence: number;
  factsHash?: string;
  text?: string;
  modelRef?: string;
  at?: number;
};

export type SystemAgentGreetingPlan = {
  text: string;
  modelRef: string;
};

export type SystemAgentGreetingPlanner = (params: {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  timeoutMs: number;
}) => Promise<SystemAgentGreetingPlan | null>;

export type SystemAgentGreetingCacheStore = Pick<
  ReturnType<typeof createSqliteAuditRecordWriter<SystemAgentGreetingCacheRecord>>,
  "compareAndSet" | "assertCurrent"
> &
  Pick<ReturnType<typeof createSqliteAuditRecordReader<SystemAgentGreetingCacheRecord>>, "latest">;

type SystemAgentGreetingConfigAuditStore = Pick<
  ReturnType<typeof createSqliteAuditRecordReader<ConfigAuditRecord>>,
  "configAuditFacts" | "assertCurrent"
>;

type SystemAgentGreetingResolution = {
  text: string;
  source: "cache" | "model" | "template";
};

const greetingFlights = new WeakMap<object, Map<string, Promise<SystemAgentGreetingResolution>>>();
const greetingFailures = new WeakMap<object, { factsHash: string; retryAfter: number }>();
const defaultGreetingCacheKey = {};

export function createSystemAgentGreetingCache(
  opts: { env?: NodeJS.ProcessEnv; assertCurrent?: () => void } = {},
): SystemAgentGreetingCacheStore {
  const options = { ...opts, scope: SYSTEM_AGENT_GREETING_SCOPE, maxEntries: 1 };
  const reader = createSqliteAuditRecordReader<SystemAgentGreetingCacheRecord>(options);
  const writer = createSqliteAuditRecordWriter<SystemAgentGreetingCacheRecord>(options);
  return { ...reader, compareAndSet: writer.compareAndSet };
}

function openConfigAuditStore(env?: NodeJS.ProcessEnv): SystemAgentGreetingConfigAuditStore {
  return createSqliteAuditRecordReader<ConfigAuditRecord>({ scope: CONFIG_AUDIT_SCOPE, env });
}

async function tryOr<T>(fallback: T, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

async function readGreetingCache(
  store: SystemAgentGreetingCacheStore,
): Promise<SystemAgentGreetingCacheRecord | null> {
  const records = await store.latest({ limit: 1 });
  store.assertCurrent();
  return records[0]?.value ?? null;
}

async function mutateGreetingState(
  store: SystemAgentGreetingCacheStore,
  mutate: (current: SystemAgentGreetingCacheRecord | null) => SystemAgentGreetingCacheRecord | null,
  createdAt = Date.now(),
): Promise<void> {
  for (let attempt = 0; attempt < GREETING_STATE_CAS_ATTEMPTS; attempt += 1) {
    const current = await readGreetingCache(store);
    store.assertCurrent();
    const next = mutate(current);
    // Only an acknowledged comparison conflict may repeat preparation.
    if (
      next === current ||
      (await store.compareAndSet(SYSTEM_AGENT_GREETING_KEY, current, next, createdAt))
    ) {
      return;
    }
  }
  throw new Error("system-agent greeting state changed too often");
}

function accountLooksDegraded(account: Record<string, unknown>): boolean {
  if (account.configured === false || account.enabled === false) {
    return false;
  }
  const healthState =
    typeof account.healthState === "string" ? account.healthState.trim().toLowerCase() : "";
  const probe =
    account.probe && typeof account.probe === "object"
      ? (account.probe as Record<string, unknown>)
      : null;
  return (
    (healthState !== "" && healthState !== "healthy") ||
    probe?.ok === false ||
    account.linked === false ||
    account.running === false ||
    (account.running === true && account.connected === false) ||
    (account.connected !== true &&
      typeof account.lastError === "string" &&
      account.lastError.trim().length > 0)
  );
}

/** Extract only degraded channel labels from the gateway's existing cached health aggregate. */
export function systemAgentGreetingChannelHealth(
  health: HealthSummary | null,
): SystemAgentGreetingFacts["channelHealth"] {
  if (!health) {
    return { available: false, degraded: [] };
  }
  const degraded = new Set<string>();
  for (const [channelId, channel] of Object.entries(health.channels)) {
    const accounts = channel.accounts ? Object.values(channel.accounts) : [channel];
    if (accounts.some((account) => accountLooksDegraded(account))) {
      degraded.add(health.channelLabels[channelId] ?? channelId);
    }
  }
  return { available: true, degraded: [...degraded].toSorted((a, b) => a.localeCompare(b)) };
}

/** Read free facts from process/SQLite snapshots; this function never starts a probe. */
export async function loadSystemAgentGreetingFacts(
  opts: {
    env?: NodeJS.ProcessEnv;
    cacheStore?: SystemAgentGreetingCacheStore;
    openCache?: () => SystemAgentGreetingCacheStore;
    configAuditStore?: SystemAgentGreetingConfigAuditStore;
    getUpdateAvailable?: () => UpdateAvailable | null;
    getHealthCache?: () => HealthSummary | null;
  } = {},
): Promise<SystemAgentGreetingFacts> {
  // Facts stay best-effort: a broken snapshot source degrades that fact
  // instead of blocking the welcome.
  // Capture both sources before either read yields; pagination keeps the same owner.
  let cacheStore: SystemAgentGreetingCacheStore | undefined;
  let auditStore: SystemAgentGreetingConfigAuditStore | undefined;
  try {
    cacheStore =
      opts.cacheStore ?? opts.openCache?.() ?? createSystemAgentGreetingCache({ env: opts.env });
  } catch {
    // Unavailable cache state leaves the audit cursor unacknowledged.
  }
  try {
    auditStore = opts.configAuditStore ?? openConfigAuditStore(opts.env);
  } catch {
    // Unavailable audit state cannot advance delivery's cursor.
  }
  const cache = await tryOr<SystemAgentGreetingCacheRecord | null>(null, () =>
    cacheStore ? readGreetingCache(cacheStore) : null,
  );
  const auditFacts = await tryOr({ auditSequence: 0, recentExternalEdit: false }, () =>
    auditStore
      ? auditStore.configAuditFacts(cache?.lastSeenAuditSequence ?? 0)
      : { auditSequence: 0, recentExternalEdit: false },
  );
  const update = await tryOr<UpdateAvailable | null>(null, () =>
    (opts.getUpdateAvailable ?? getUpdateAvailable)(),
  );
  const health = await tryOr<HealthSummary | null>(null, () =>
    (opts.getHealthCache ?? getHealthCache)(),
  );
  cacheStore?.assertCurrent();
  auditStore?.assertCurrent();
  return {
    updateAvailable: update?.latestVersion ?? null,
    channelHealth: systemAgentGreetingChannelHealth(health),
    ...auditFacts,
  };
}

/** SHA-256 over greeting decisions only; paths, errors, timestamps, and tool probes stay out. */
export function systemAgentGreetingFactsHash(
  overview: SystemAgentOverview,
  facts: SystemAgentGreetingFacts,
): string {
  const decisionFacts = {
    config: {
      exists: overview.config.exists,
      valid: overview.config.valid,
    },
    defaultAgentId: overview.defaultAgentId,
    defaultModel: overview.defaultModel ?? null,
    setupModel: overview.setupModel ?? null,
    utilityModel: overview.utilityModel ?? null,
    gateway: {
      reachable: overview.gateway.reachable,
      url: overview.gateway.url,
    },
    agents: overview.agents
      .map((agent) => ({
        id: agent.id,
        name: agent.name ?? null,
        isDefault: agent.isDefault,
        model: agent.model ?? null,
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
    updateAvailable: facts.updateAvailable,
    channelHealthAvailable: facts.channelHealth.available,
    degradedChannels: [...facts.channelHealth.degraded].toSorted((a, b) => a.localeCompare(b)),
    // recentExternalEdit is deliberately absent: its alert is host-appended at
    // delivery, so the cached model text stays valid across edit-flag flips.
  };
  return createHash("sha256").update(JSON.stringify(decisionFacts)).digest("hex");
}

function normalizeGreetingText(text: string): string | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, SYSTEM_AGENT_GREETING_MAX_LINES);
  if (lines.length === 0 || lines.some((line) => /^#{1,6}\s/.test(line))) {
    return null;
  }
  // The prompt demands plain markdown lines; structured output must never be
  // cached (a single bad slot would replay on every welcome until facts change).
  // Every retained line is checked so a "Sure:" preamble cannot smuggle JSON.
  if (lines.some((line) => /^[[{]/.test(line) || line.startsWith("```"))) {
    return null;
  }
  return truncateUtf16Safe(lines.join("\n"), SYSTEM_AGENT_GREETING_MAX_CHARS).trim() || null;
}

/**
 * The external-edit alert is host-owned: delivery acknowledges the audit
 * cursor, so a model phrasing miss would silently lose the notification.
 * Appending deterministically removes that class instead of validating it.
 */
export const SYSTEM_AGENT_EXTERNAL_EDIT_ALERT =
  "Heads up: the config was edited outside OpenClaw while I was away — open History to review it.";

function withHostOwnedAlerts(text: string, facts: SystemAgentGreetingFacts): string {
  if (!facts.recentExternalEdit) {
    return text;
  }
  return `${text}\n${SYSTEM_AGENT_EXTERNAL_EDIT_ALERT}`;
}

/**
 * Positive-presence grounding only: exceptional facts the model was given must
 * appear in its text. Deliberately no negative-claim screening — keyword
 * blacklists false-reject phrasing like "no channels are degraded", and the
 * greeting is advisory chat text; chips, History, and health stay host-owned.
 * A hallucinated outage is bounded by the prompt, the 5-line cap, and template
 * fallback on the next facts change. Accepted tradeoff, not an oversight.
 */
function modelGreetingCoversFacts(text: string, facts: SystemAgentGreetingFacts): boolean {
  const normalized = text.toLocaleLowerCase();
  if (facts.updateAvailable && !normalized.includes(facts.updateAvailable.toLocaleLowerCase())) {
    return false;
  }
  if (
    facts.channelHealth.degraded.some((label) => !normalized.includes(label.toLocaleLowerCase()))
  ) {
    return false;
  }
  if (
    !facts.channelHealth.available &&
    !(normalized.includes("channel health") && normalized.includes("unavailable"))
  ) {
    return false;
  }
  return true;
}

function requiresDeterministicGreeting(overview: SystemAgentOverview): boolean {
  return (
    !overview.config.exists ||
    !overview.config.valid ||
    !overview.defaultModel ||
    !overview.gateway.reachable
  );
}

function resolveSystemAgentGreetingFallback(
  overview: SystemAgentOverview,
  facts: SystemAgentGreetingFacts,
): SystemAgentGreetingResolution {
  const alerts: string[] = [];
  if (facts.updateAvailable) {
    alerts.push(`Update ${facts.updateAvailable} is available.`);
  }
  if (facts.channelHealth.degraded.length > 0) {
    alerts.push(`Channels needing attention: ${facts.channelHealth.degraded.join(", ")}.`);
  } else if (!facts.channelHealth.available) {
    alerts.push("Channel health is not available yet.");
  }
  // recentExternalEdit is deliberately absent: withHostOwnedAlerts appends the
  // single canonical edit alert to every delivered greeting, template included.
  return {
    text: [formatSystemAgentStartupMessage(overview), alerts.join(" ") || undefined]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
    source: "template",
  };
}

async function resolveUncachedSystemAgentGreeting(params: {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  planner: SystemAgentGreetingPlanner;
  cacheStore: SystemAgentGreetingCacheStore;
  factsHash: string;
  cacheKey: object;
  at: number;
  timeoutMs?: number;
}): Promise<SystemAgentGreetingResolution> {
  const timeoutMs = params.timeoutMs ?? SYSTEM_AGENT_GREETING_TIMEOUT_MS;
  let plan: SystemAgentGreetingPlan | null = null;
  try {
    // This is the only metered greeting turn. The single-slot hash keeps unchanged
    // caretaker opens at zero tokens while preserving a model-free rescue path.
    plan = await raceWithTimeout(
      params.planner({ overview: params.overview, facts: params.facts, timeoutMs }),
      timeoutMs,
      () => null,
      { ref: false },
    );
  } catch {
    plan = null;
  }
  const text = plan ? normalizeGreetingText(plan.text) : null;
  const groundedText = text && modelGreetingCoversFacts(text, params.facts) ? text : null;
  if (!groundedText || !plan?.modelRef.trim()) {
    // Keep provider outages cheap without writing a template into the model-greeting cache.
    greetingFailures.set(params.cacheKey, {
      factsHash: params.factsHash,
      retryAfter: params.at + SYSTEM_AGENT_GREETING_FAILURE_RETRY_MS,
    });
    return resolveSystemAgentGreetingFallback(params.overview, params.facts);
  }
  greetingFailures.delete(params.cacheKey);
  try {
    await mutateGreetingState(
      params.cacheStore,
      (current) => {
        // A slower turn for old facts must not replace a newer system-state greeting.
        if (
          current?.factsHash &&
          current.factsHash !== params.factsHash &&
          (current.at ?? Number.NEGATIVE_INFINITY) >= params.at
        ) {
          return current;
        }
        return {
          ...current,
          lastSeenAuditSequence: current?.lastSeenAuditSequence ?? 0,
          factsHash: params.factsHash,
          text: groundedText,
          modelRef: plan.modelRef.trim(),
          at: params.at,
        };
      },
      params.at,
    );
  } catch {
    // Cache persistence is diagnostic-only; a successful greeting still wins.
  }
  params.cacheStore.assertCurrent();
  return { text: groundedText, source: "model" };
}

type ResolveSystemAgentGreetingParams = {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  planner: SystemAgentGreetingPlanner;
  /** False for internal session seeding: cache reads stay free and a miss uses the template. */
  allowInference?: boolean;
  cacheStore?: SystemAgentGreetingCacheStore;
  /** The Gateway session owner retains flight/backoff identity across captured reads. */
  cacheOwner?: object;
  openCache?: () => SystemAgentGreetingCacheStore;
  now?: () => number;
  timeoutMs?: number;
};

export async function resolveSystemAgentGreeting(
  params: ResolveSystemAgentGreetingParams,
): Promise<SystemAgentGreetingResolution> {
  const resolution = await resolveSystemAgentGreetingText(params);
  params.cacheStore?.assertCurrent();
  // Host-owned alerts append at delivery, never into the cache: the cached
  // model text must stay valid for deliveries where the fact is absent.
  return { ...resolution, text: withHostOwnedAlerts(resolution.text, params.facts) };
}

async function resolveSystemAgentGreetingText(
  params: ResolveSystemAgentGreetingParams,
): Promise<SystemAgentGreetingResolution> {
  if (requiresDeterministicGreeting(params.overview)) {
    // When the system is broken, precision beats personality: the rescue path
    // must neither depend on nor spend inference, and model text is never cached.
    return resolveSystemAgentGreetingFallback(params.overview, params.facts);
  }
  let cacheStore: SystemAgentGreetingCacheStore;
  try {
    cacheStore = params.cacheStore ?? params.openCache?.() ?? createSystemAgentGreetingCache();
  } catch {
    return resolveSystemAgentGreetingFallback(params.overview, params.facts);
  }
  const factsHash = systemAgentGreetingFactsHash(params.overview, params.facts);
  let cached: SystemAgentGreetingCacheRecord | null;
  try {
    cached = await readGreetingCache(cacheStore);
  } catch {
    return resolveSystemAgentGreetingFallback(params.overview, params.facts);
  }
  if (
    typeof cached?.text === "string" &&
    cached.text.trim() &&
    cached.factsHash === factsHash &&
    typeof cached.modelRef === "string" &&
    typeof cached.at === "number"
  ) {
    return { text: cached.text, source: "cache" };
  }
  if (params.allowInference === false) {
    return resolveSystemAgentGreetingFallback(params.overview, params.facts);
  }

  cacheStore.assertCurrent();
  const cacheKey =
    params.cacheOwner ??
    (params.cacheStore || params.openCache ? cacheStore : defaultGreetingCacheKey);
  const at = (params.now ?? Date.now)();
  // This timestamp orders competing model-cache writes; audit acknowledgement uses
  // the monotonic sequence captured with the facts instead of wall-clock time.
  const failure = greetingFailures.get(cacheKey);
  if (failure?.factsHash === factsHash && failure.retryAfter > at) {
    return resolveSystemAgentGreetingFallback(params.overview, params.facts);
  }
  if (failure && failure.retryAfter <= at) {
    greetingFailures.delete(cacheKey);
  }
  let flights = greetingFlights.get(cacheKey);
  if (!flights) {
    flights = new Map();
    greetingFlights.set(cacheKey, flights);
  }
  const existingFlight = flights.get(factsHash);
  if (existingFlight) {
    const result = await existingFlight;
    cacheStore.assertCurrent();
    return result;
  }
  const flight = resolveUncachedSystemAgentGreeting({
    ...params,
    cacheStore,
    factsHash,
    cacheKey,
    at,
  });
  flights.set(factsHash, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(factsHash) === flight) {
      flights.delete(factsHash);
    }
  }
}

/** Persist the config-audit cursor only after the host has delivered the greeting. */
export async function acknowledgeSystemAgentGreetingDelivery(params: {
  auditSequence: number;
  cacheStore?: SystemAgentGreetingCacheStore;
  openCache?: () => SystemAgentGreetingCacheStore;
  now?: () => number;
}): Promise<void> {
  if (!Number.isSafeInteger(params.auditSequence) || params.auditSequence < 0) {
    return;
  }
  try {
    const cacheStore =
      params.cacheStore ?? params.openCache?.() ?? createSystemAgentGreetingCache();
    await mutateGreetingState(
      cacheStore,
      (current) => {
        const lastSeenAuditSequence = Math.max(
          current?.lastSeenAuditSequence ?? 0,
          params.auditSequence,
        );
        if (current?.lastSeenAuditSequence === lastSeenAuditSequence) {
          return current;
        }
        return {
          ...current,
          lastSeenAuditSequence,
        };
      },
      (params.now ?? Date.now)(),
    );
  } catch {
    // Delivery wins even when diagnostic acknowledgement cannot be persisted.
  }
}

/** Quick actions are host-derived so model wording can never invent executable replies. */
export function buildSystemAgentGreetingQuestion(
  overview: SystemAgentOverview,
  facts: SystemAgentGreetingFacts,
): SystemAgentChatQuestion {
  const exceptional: SystemAgentChatQuestion["options"] = [];
  if (!overview.config.exists) {
    exceptional.push({ label: "Set up OpenClaw", reply: "setup" });
  } else if (!overview.config.valid) {
    exceptional.push({ label: "Inspect config", reply: "doctor" });
  } else if (!overview.defaultModel) {
    // A valid config without verified inference cannot hand off to an agent;
    // setup is the canonical path to establish a model.
    exceptional.push(
      overview.setupModel
        ? { label: "Choose agent model", reply: "model setup" }
        : { label: "Set up inference", reply: "setup" },
    );
  }
  if (!overview.gateway.reachable) {
    exceptional.push({ label: "Run gateway status", reply: "gateway status" });
    exceptional.push({ label: "Restart gateway", reply: "restart gateway" });
  }
  if (!facts.channelHealth.available || facts.channelHealth.degraded.length > 0) {
    exceptional.push({ label: "Check channel health", reply: "health" });
  }
  if (facts.updateAvailable) {
    exceptional.push({ label: "Show update", reply: "status" });
  }
  // Keep History and agent handoff reachable even when several exceptional facts compete
  // for the schema's four slots. The greeting itself still names every exceptional fact.
  const options = exceptional.slice(0, 2);
  // Without a model the handoff chip would advertise a dead action; the
  // no-model branch above already routes users to setup instead.
  if (overview.defaultModel) {
    options.push({
      label: "Talk to my agent",
      reply: "talk to agent",
      recommended:
        exceptional.length === 0 &&
        !facts.recentExternalEdit &&
        facts.channelHealth.available &&
        overview.config.exists &&
        overview.config.valid &&
        overview.gateway.reachable,
    });
  }
  options.push({
    label: facts.recentExternalEdit ? "Review recent changes" : "Show recent changes",
    reply: "audit",
  });
  return {
    id: "system-agent-quick-actions",
    header: "Quick actions",
    question: "What would you like me to do?",
    options,
  };
}
