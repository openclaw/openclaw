import createDebug from "debug";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.agents.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeChatChannelId } from "../channels/registry.js";
import { normalizeAccountId, normalizeAgentId } from "./session-key.js";

const debug = createDebug("openclaw:routing:bindings");

const AgentBindingSchema = z.object({
  agentId: z.string(),
  match: z.object({
    channel: z.string(),
    accountId: z.string().optional(),
    peer: z
      .object({
        kind: z.enum(["dm", "group", "channel"]),
        id: z.string(),
      })
      .optional(),
    guildId: z.string().optional(),
    teamId: z.string().optional(),
  }),
});

function normalizeBindingChannelId(raw?: string | null): string | null {
  const normalized = normalizeChatChannelId(raw);
  if (normalized) {
    return normalized;
  }
  const fallback = (raw ?? "").trim().toLowerCase();
  return fallback || null;
}

let cachedExtraBindings: AgentBinding[] | null = null;

export function loadExtraBindings(): AgentBinding[] {
  if (cachedExtraBindings !== null) {
    return cachedExtraBindings;
  }
  try {
    const path = join(homedir(), ".openclaw", "routing.json");
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      const json = JSON.parse(content);
      if (Array.isArray(json)) {
        const bindings: AgentBinding[] = [];
        for (let i = 0; i < json.length; i++) {
          const result = AgentBindingSchema.safeParse(json[i]);
          if (result.success) {
            bindings.push(result.data as AgentBinding);
          } else {
            debug(`Invalid binding at index ${i}: %O`, result.error.format());
          }
        }
        cachedExtraBindings = bindings;
        return cachedExtraBindings;
      } else {
        debug("routing.json root must be an array");
      }
    }
  } catch (error) {
    debug("Failed to load routing.json: %O", error);
  }
  cachedExtraBindings = [];
  return cachedExtraBindings;
}

export function resetBindingsCacheForTest() {
  cachedExtraBindings = null;
}

export function listBindings(cfg: OpenClawConfig): AgentBinding[] {
  const extra = loadExtraBindings();
  const configBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  return [...extra, ...configBindings];
}

export function listBoundAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  const normalizedChannel = normalizeBindingChannelId(channelId);
  if (!normalizedChannel) {
    return [];
  }
  const ids = new Set<string>();
  for (const binding of listBindings(cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    const match = binding.match;
    if (!match || typeof match !== "object") {
      continue;
    }
    const channel = normalizeBindingChannelId(match.channel);
    if (!channel || channel !== normalizedChannel) {
      continue;
    }
    const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
    if (!accountId || accountId === "*") {
      continue;
    }
    ids.add(normalizeAccountId(accountId));
  }
  return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultAgentBoundAccountId(
  cfg: OpenClawConfig,
  channelId: string,
): string | null {
  const normalizedChannel = normalizeBindingChannelId(channelId);
  if (!normalizedChannel) {
    return null;
  }
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  for (const binding of listBindings(cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    if (normalizeAgentId(binding.agentId) !== defaultAgentId) {
      continue;
    }
    const match = binding.match;
    if (!match || typeof match !== "object") {
      continue;
    }
    const channel = normalizeBindingChannelId(match.channel);
    if (!channel || channel !== normalizedChannel) {
      continue;
    }
    const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
    if (!accountId || accountId === "*") {
      continue;
    }
    return normalizeAccountId(accountId);
  }
  return null;
}

export function buildChannelAccountBindings(cfg: OpenClawConfig) {
  const map = new Map<string, Map<string, string[]>>();
  for (const binding of listBindings(cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    const match = binding.match;
    if (!match || typeof match !== "object") {
      continue;
    }
    const channelId = normalizeBindingChannelId(match.channel);
    if (!channelId) {
      continue;
    }
    const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
    if (!accountId || accountId === "*") {
      continue;
    }
    const agentId = normalizeAgentId(binding.agentId);
    const byAgent = map.get(channelId) ?? new Map<string, string[]>();
    const list = byAgent.get(agentId) ?? [];
    const normalizedAccountId = normalizeAccountId(accountId);
    if (!list.includes(normalizedAccountId)) {
      list.push(normalizedAccountId);
    }
    byAgent.set(agentId, list);
    map.set(channelId, byAgent);
  }
  return map;
}

export function resolvePreferredAccountId(params: {
  accountIds: string[];
  defaultAccountId: string;
  boundAccounts: string[];
}): string {
  if (params.boundAccounts.length > 0) {
    return params.boundAccounts[0];
  }
  return params.defaultAccountId;
}
