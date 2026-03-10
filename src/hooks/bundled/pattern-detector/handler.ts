import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../../config/sessions/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type {
  PluginHookBeforeAgentStartEvent,
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
} from "../../../plugins/types.js";
import { resolveHookConfig } from "../../config.js";
import { runSenderCheck } from "./sender-check.js";

const log = createSubsystemLogger("hooks/pattern-detector");

// --- Outbound alert cooldown (breaks re-alert loops) ---
const COOLDOWN_FILE = "outbound-alert-cooldowns.json";
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type CooldownMap = Record<string, number>; // alert string → timestamp ms

function loadAlertCooldowns(agentId?: string): CooldownMap {
  try {
    const dir = resolveSessionTranscriptsDirForAgent(agentId);
    const file = path.join(dir, COOLDOWN_FILE);
    if (!fs.existsSync(file)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function saveAlertCooldowns(agentId: string | undefined, cooldowns: CooldownMap): void {
  try {
    const dir = resolveSessionTranscriptsDirForAgent(agentId);
    const file = path.join(dir, COOLDOWN_FILE);
    fs.writeFileSync(file, JSON.stringify(cooldowns));
  } catch {
    // silent — cooldown persistence failure is non-critical
  }
}

export type PatternDefinition = {
  id: string;
  label: string;
  regex: string;
  flags?: string;
  template: string;
  enabled: boolean;
  direction?: "inbound" | "outbound" | "both";
};

export type SenderCheckConfig = {
  enabled: boolean;
  ownerNumbers: string[];
  briefingFile: string;
  maxBriefingChars: number;
  debounceMinutes: number;
  knownTemplate: string;
  unknownTemplate: string;
};

type PatternDetectorHookConfig = {
  enabled?: boolean;
  patterns?: PatternDefinition[];
  outboundCooldownMinutes?: number;
  senderCheck?: SenderCheckConfig;
};

function isSenderCheckConfig(value: unknown): value is SenderCheckConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const config = value as Record<string, unknown>;
  return (
    typeof config.enabled === "boolean" &&
    Array.isArray(config.ownerNumbers) &&
    config.ownerNumbers.every((item) => typeof item === "string") &&
    typeof config.briefingFile === "string" &&
    typeof config.maxBriefingChars === "number" &&
    typeof config.debounceMinutes === "number" &&
    typeof config.knownTemplate === "string" &&
    typeof config.unknownTemplate === "string"
  );
}

export const DEFAULT_PATTERNS: PatternDefinition[] = [
  {
    id: "phone",
    label: "Telefone",
    regex: "\\+?\\d{2}\\s?\\(?\\d{2}\\)?\\s?\\d{4,5}[-.\\s]?\\d{4}",
    flags: "g",
    template: "⚡ Numero detectado: {{match}}. Verificar: existe nos contatos? Salvar?",
    enabled: true,
    direction: "inbound",
  },
  {
    id: "date",
    label: "Data",
    regex: "\\d{1,2}/\\d{1,2}(/\\d{2,4})?",
    flags: "g",
    template: "📅 Data mencionada: {{match}}. Criar evento/lembrete?",
    enabled: true,
    direction: "inbound",
  },
  {
    id: "currency",
    label: "Valor R$",
    regex: "R\\$\\s?[\\d.,]+",
    flags: "g",
    template: "💰 Valor detectado: {{match}}. Registrar no financeiro?",
    enabled: true,
    direction: "inbound",
  },
  {
    id: "url",
    label: "Link/URL",
    regex: "https?://\\S+",
    flags: "gi",
    template: "🔗 Link recebido: {{match}}. Classificar e salvar?",
    enabled: true,
    direction: "inbound",
  },
];

// Regex compilation cache to avoid recompilation per prompt
const regexCache = new Map<string, RegExp | null>();

function compileRegex(pattern: string, flags: string): RegExp | null {
  const key = `${pattern}::${flags}`;
  if (regexCache.has(key)) {
    return regexCache.get(key)!;
  }
  try {
    const re = new RegExp(pattern, flags);
    regexCache.set(key, re);
    return re;
  } catch (err) {
    log.warn(`Invalid regex pattern: ${pattern} — ${String(err)}`);
    regexCache.set(key, null);
    return null;
  }
}

export function runPatternMatching(
  text: string,
  patterns: PatternDefinition[],
  directionFilter: "inbound" | "outbound",
): string[] {
  // Strip bracket metadata only for inbound (envelope headers, structural markers)
  let body = directionFilter === "inbound" ? text.replace(/\[[^\]]+\]\s*/g, "") : text;

  // Strip inbound metadata noise to avoid false positive pattern detection
  if (directionFilter === "inbound") {
    // Strip WhatsApp LID references (digits@lid)
    body = body.replace(/\d+@lid\b/g, "");
    // Strip entire lines containing @lid (catches formatted/partial references)
    body = body.replace(/^.*@lid.*$/gm, "");
    // Strip JSON/markdown code blocks entirely (reply context, conversation metadata)
    body = body.replace(/```[\s\S]*?```/g, "");
    // Strip "Replied message" sections (untrusted metadata with internal IDs)
    body = body.replace(/Replied message[\s\S]*?(?=\n[A-Z]|\n\n\S|$)/g, "");
    // Strip Sender/Conversation info metadata blocks
    body = body.replace(/(?:Sender|Conversation info) \(untrusted[\s\S]*?(?=\n\n\S|$)/g, "");
    // Strip previous pattern detector output to avoid feedback loops
    body = body.replace(/Numero detectado:\s*\+?\d+/g, "");
    // Strip WhatsApp message IDs that look like phone numbers (hex+decimal mix e.g. 3EB01411705151666EF660)
    body = body.replace(/\b[0-9A-F]{20,}\b/gi, "");

    log.debug(
      `[strip] body after all strips (${body.length} chars): ${body.slice(0, 300).replace(/\n/g, "\\n")}`,
    );
  }

  const alerts: string[] = [];
  const seenMatches = new Set<string>();

  for (const pattern of patterns) {
    if (!pattern.enabled) {
      continue;
    }

    // Skip patterns that don't match the direction filter
    const patternDir = pattern.direction ?? "inbound";
    if (patternDir !== "both" && patternDir !== directionFilter) {
      continue;
    }

    const flags = pattern.flags ?? "g";
    const re = compileRegex(pattern.regex, flags);
    if (!re) {
      continue;
    }

    re.lastIndex = 0;
    let matchCount = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(body)) !== null && matchCount < 20) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }

      const matchValue = match[0];
      const dedupeKey = `${pattern.id}::${matchValue}`;
      if (seenMatches.has(dedupeKey)) {
        continue;
      }
      seenMatches.add(dedupeKey);

      const alert = pattern.template.replace(/\{\{match\}\}/g, matchValue);
      alerts.push(alert);
      matchCount++;

      // For non-global regex, break after first match
      if (!flags.includes("g")) {
        break;
      }
    }
  }

  return alerts;
}

/**
 * Drain pending outbound alerts written by deliver.ts.
 * Reads and truncates the pending-outbound-alerts.jsonl file atomically.
 */
function drainPendingOutboundAlerts(agentId?: string): string[] {
  try {
    const alertsDir = resolveSessionTranscriptsDirForAgent(agentId);
    const alertsFile = path.join(alertsDir, "pending-outbound-alerts.jsonl");

    if (!fs.existsSync(alertsFile)) {
      return [];
    }

    const raw = fs.readFileSync(alertsFile, "utf-8").trim();
    if (!raw) {
      return [];
    }

    // Truncate immediately to avoid double-processing
    fs.writeFileSync(alertsFile, "");

    const allAlerts: string[] = [];
    for (const line of raw.split("\n")) {
      try {
        const entry = JSON.parse(line) as { alerts?: string[] };
        if (Array.isArray(entry.alerts)) {
          allAlerts.push(...entry.alerts);
        }
      } catch {
        // skip malformed lines
      }
    }

    if (allAlerts.length > 0) {
      log.info(`[outbound] drained ${allAlerts.length} pending alerts`);
    }
    return allAlerts;
  } catch {
    return [];
  }
}

/**
 * Extract sender metadata from the prompt text when event.senderMetadata is not populated.
 * Parses "Sender (untrusted metadata):" and "Conversation info (untrusted metadata):" JSON blocks.
 */
function enrichSenderMetadataFromPrompt(
  event: PluginHookBeforeAgentStartEvent,
): PluginHookBeforeAgentStartEvent {
  // If senderMetadata is already populated, use it as-is
  if (event.senderMetadata?.senderE164) {
    return event;
  }

  const prompt = event.prompt ?? "";

  // Extract sender E164 from "Sender (untrusted metadata):" JSON block
  const senderBlockMatch = prompt.match(
    /Sender\s*\(untrusted[^)]*\):\s*```json\s*(\{[\s\S]*?\})\s*```/,
  );
  let senderE164: string | undefined;
  let senderName: string | undefined;

  if (senderBlockMatch) {
    try {
      const senderData = JSON.parse(senderBlockMatch[1]) as Record<string, unknown>;
      if (typeof senderData.e164 === "string") {
        senderE164 = senderData.e164;
      }
      if (typeof senderData.name === "string") {
        senderName = senderData.name;
      }
    } catch {
      // JSON parse failed, try regex fallback
    }
  }

  // Regex fallback: extract e164 from the raw text
  if (!senderE164) {
    const e164Match = prompt.match(/"e164"\s*:\s*"(\+\d{10,15})"/);
    if (e164Match) {
      senderE164 = e164Match[1];
    }
  }
  if (!senderName) {
    const nameMatch = prompt.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch) {
      senderName = nameMatch[1];
    }
  }

  // Extract chat_type from "Conversation info" block
  const convMatch = prompt.match(/"chat_type"\s*:\s*"(group|direct)"/);
  const chatType = convMatch ? (convMatch[1] as "group" | "direct") : undefined;

  if (!senderE164 && !senderName) {
    log.debug("enrichSenderMetadata: no sender info found in prompt");
    return event;
  }

  log.debug(
    `enrichSenderMetadata: extracted e164=${senderE164 ?? "?"} name=${senderName ?? "?"} chatType=${chatType ?? "?"}`,
  );

  return {
    ...event,
    senderMetadata: {
      ...event.senderMetadata,
      senderE164,
      senderName,
      chatType,
      senderIsOwner: false, // If we're extracting from prompt, it's not the owner (owner messages don't have Sender blocks)
      sessionKey: event.senderMetadata?.sessionKey,
    },
  };
}

export async function patternDetectorHandler(
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeAgentStartResult | void> {
  const cfg = loadConfig();
  const hookConfig = resolveHookConfig(cfg, "pattern-detector") as PatternDetectorHookConfig;

  if (hookConfig?.enabled === false) {
    return;
  }

  const patterns: PatternDefinition[] = Array.isArray(hookConfig?.patterns)
    ? hookConfig.patterns
    : DEFAULT_PATTERNS;

  const allAlerts: string[] = [];

  // 1. Sender identity check (high-priority context, prepended before pattern alerts)
  //    The upstream does not populate event.senderMetadata, so we extract sender
  //    info from the prompt metadata blocks (Sender/Conversation info JSON).
  if (isSenderCheckConfig(hookConfig?.senderCheck) && hookConfig.senderCheck.enabled) {
    const enrichedEvent = enrichSenderMetadataFromPrompt(event);
    const senderAlert = runSenderCheck(enrichedEvent, ctx, hookConfig.senderCheck);
    if (senderAlert) {
      allAlerts.unshift(senderAlert);
    }
  }

  // 2. Inbound pattern matching (no cooldown — user messages are organic)
  const prompt = event.prompt;
  if (prompt) {
    const inboundAlerts = runPatternMatching(prompt, patterns, "inbound");
    if (inboundAlerts.length > 0) {
      // Debug: log what the prompt looks like after stripping (first 500 chars)
      log.debug(
        `[inbound] ${inboundAlerts.length} alerts from prompt (${prompt.length} chars). First 200 of prompt: ${prompt.slice(0, 200).replace(/\n/g, "\\n")}`,
      );
    }
    allAlerts.push(...inboundAlerts);
  }

  // 3. Drain pending outbound alerts with cooldown dedup
  const rawOutbound = drainPendingOutboundAlerts(ctx.agentId);
  if (rawOutbound.length > 0) {
    const cooldownMs =
      typeof hookConfig?.outboundCooldownMinutes === "number"
        ? hookConfig.outboundCooldownMinutes * 60 * 1000
        : DEFAULT_COOLDOWN_MS;
    const cooldowns = loadAlertCooldowns(ctx.agentId);
    const now = Date.now();

    // Prune expired entries
    for (const key of Object.keys(cooldowns)) {
      if (now - cooldowns[key] > cooldownMs) {
        delete cooldowns[key];
      }
    }

    // Filter: skip alerts still in cooldown
    const fresh = rawOutbound.filter(
      (alert) => !(alert in cooldowns) || now - cooldowns[alert] > cooldownMs,
    );

    // Record delivered alerts
    for (const alert of fresh) {
      cooldowns[alert] = now;
    }

    saveAlertCooldowns(ctx.agentId, cooldowns);

    if (fresh.length < rawOutbound.length) {
      log.debug(
        `[outbound] suppressed ${rawOutbound.length - fresh.length} duplicate alerts (cooldown)`,
      );
    }

    allAlerts.push(...fresh);
  }

  if (allAlerts.length === 0) {
    return;
  }

  log.debug(`Pattern detector found ${allAlerts.length} alerts (sender-check+inbound+outbound)`);

  return {
    prependContext: `[Pattern Detector]\n${allAlerts.join("\n")}`,
  };
}
