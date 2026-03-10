/**
 * Agent Registry Service — validates agent marketplace manifests at gateway
 * startup. Invalid agents are disabled (degraded mode); the gateway always
 * continues starting.
 *
 * This is a hard requirement: a single misconfigured agent must never crash
 * the gateway.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadAgentFromDir,
  validateTierDependencies,
  type AgentManifest,
} from "../config/agent-manifest-validation.js";
import type { AgentScope } from "../config/agent-scope.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RegisteredAgent {
  manifest: AgentManifest;
  scope: AgentScope;
  promptContent?: string;
  status: "active" | "disabled";
  disableReason?: string;
}

export interface AgentRegistryState {
  agents: RegisteredAgent[];
  activeAgents: RegisteredAgent[];
  disabledAgents: RegisteredAgent[];
  degraded: boolean;
}

// ── Scope directories ────────────────────────────────────────────────────────

function scopeDirs(projectRoot: string): { scope: AgentScope; dir: string }[] {
  return [
    { scope: "local", dir: join(projectRoot, ".openclaw", "agents.local") },
    { scope: "project", dir: join(projectRoot, ".openclaw", "agents") },
    { scope: "user", dir: join(homedir(), ".openclaw", "agents") },
  ];
}

// ── Registry builder ─────────────────────────────────────────────────────────

/**
 * Load all installed agents from all scopes, validate them, and return
 * the registry state. Invalid agents are marked as disabled.
 *
 * Scope resolution: local → project → user (narrowest wins on ID collision).
 */
export async function buildAgentRegistry(
  projectRoot: string,
  log: (msg: string) => void = () => {},
): Promise<AgentRegistryState> {
  const agentMap = new Map<string, RegisteredAgent>();

  // Load from broadest to narrowest scope so narrower wins
  const scopes = scopeDirs(projectRoot);
  for (const { scope, dir } of [...scopes].toReversed()) {
    await loadFromScope(scope, dir, agentMap, log);
  }
  for (const { scope, dir } of scopes) {
    await loadFromScope(scope, dir, agentMap, log);
  }

  const agents = Array.from(agentMap.values());

  // Validate tier dependencies
  const activeManifests = agents.filter((a) => a.status === "active").map((a) => a.manifest);

  const tierResult = validateTierDependencies(activeManifests);

  // Disable agents with broken dependencies
  if (!tierResult.valid) {
    for (const error of tierResult.errors) {
      // Extract agent ID from error message
      const match = error.match(/^Agent "([^"]+)"/);
      if (match) {
        const agent = agentMap.get(match[1]);
        if (agent) {
          agent.status = "disabled";
          agent.disableReason = error;
          log(`[agent-registry] DISABLED: ${agent.manifest.id} — ${error}`);
        }
      }
    }
  }

  for (const warning of tierResult.warnings) {
    log(`[agent-registry] WARNING: ${warning}`);
  }

  const activeAgents = agents.filter((a) => a.status === "active");
  const disabledAgents = agents.filter((a) => a.status === "disabled");

  if (disabledAgents.length > 0) {
    log(
      `[agent-registry] Loaded ${activeAgents.length} agents (${disabledAgents.length} disabled)`,
    );
  } else if (agents.length > 0) {
    log(`[agent-registry] Loaded ${agents.length} agents`);
  }

  return {
    agents,
    activeAgents,
    disabledAgents,
    degraded: disabledAgents.length > 0,
  };
}

async function loadFromScope(
  scope: AgentScope,
  dir: string,
  agentMap: Map<string, RegisteredAgent>,
  log: (msg: string) => void,
): Promise<void> {
  let entries: string[];
  try {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    entries = dirEntries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return; // Directory doesn't exist
  }

  for (const entry of entries) {
    const agentDir = join(dir, entry);
    try {
      const result = await loadAgentFromDir(agentDir);
      if (result.manifest) {
        if (result.errors.length > 0) {
          agentMap.set(result.manifest.id, {
            manifest: result.manifest,
            scope,
            promptContent: result.promptContent,
            status: "disabled",
            disableReason: result.errors.join("; "),
          });
          log(`[agent-registry] DISABLED: ${result.manifest.id} — ${result.errors.join("; ")}`);
        } else {
          agentMap.set(result.manifest.id, {
            manifest: result.manifest,
            scope,
            promptContent: result.promptContent,
            status: "active",
          });
        }
      } else if (result.errors.length > 0) {
        log(`[agent-registry] Skipped ${entry}: ${result.errors.join("; ")}`);
      }
    } catch (err) {
      log(`[agent-registry] Error loading ${entry}: ${(err as Error).message}`);
    }
  }
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Score an agent against a task description using keyword matching.
 * Returns a score (higher = better match).
 */
function scoreAgent(agent: AgentManifest, taskTokens: Set<string>): number {
  let score = 0;

  // Primary signal: keyword overlap
  const keywords = agent.routing_hints?.keywords ?? [];
  for (const keyword of keywords) {
    const kwTokens = keyword.toLowerCase().split(/\s+/);
    for (const t of kwTokens) {
      if (taskTokens.has(t)) {
        score += 2;
      }
    }
  }

  // Secondary signal: capabilities semantic match
  const capabilities = agent.capabilities ?? [];
  for (const cap of capabilities) {
    const capTokens = cap.toLowerCase().split(/_/);
    for (const t of capTokens) {
      if (taskTokens.has(t)) {
        score += 1;
      }
    }
  }

  return score;
}

export interface RoutingResult {
  agent: RegisteredAgent | null;
  confidence: number;
  scores: { agentId: string; score: number }[];
  needsClarification: boolean;
}

/**
 * Route a task to the best matching Tier 2 department head.
 *
 * Algorithm (from implementation spec):
 * 1. Tokenize task
 * 2. Score each active Tier 2 agent via keyword + capabilities matching
 * 3. Apply priority as tiebreaker (high > normal > low)
 * 4. Below confidence threshold → ask for clarification
 * 5. Tied score+priority → alphabetical (deterministic, logged for tuning)
 */
export function routeTask(
  taskDescription: string,
  registry: AgentRegistryState,
  confidenceThreshold = 2,
): RoutingResult {
  const taskTokens = new Set(
    taskDescription
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );

  const tier2 = registry.activeAgents.filter((a) => a.manifest.tier === 2);
  if (tier2.length === 0) {
    return { agent: null, confidence: 0, scores: [], needsClarification: true };
  }

  const priorityWeight: Record<string, number> = { high: 0.3, normal: 0, low: -0.3 };

  const scored = tier2
    .map((a) => {
      const base = scoreAgent(a.manifest, taskTokens);
      const priority = a.manifest.routing_hints?.priority ?? "normal";
      return {
        agent: a,
        score: base + (priorityWeight[priority] ?? 0),
      };
    })
    .toSorted((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.agent.manifest.id.localeCompare(b.agent.manifest.id); // alphabetical tiebreak
    });

  const top = scored[0];
  const scores = scored.map((s) => ({ agentId: s.agent.manifest.id, score: s.score }));

  if (top.score < confidenceThreshold) {
    return { agent: null, confidence: top.score, scores, needsClarification: true };
  }

  return {
    agent: top.agent,
    confidence: top.score,
    scores,
    needsClarification: false,
  };
}
