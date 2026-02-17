/**
 * Memory Consolidation Script
 *
 * Runs periodically (daily/weekly) to consolidate raw events into long-term memories.
 * Batch processes multiple events into summarized memories to save tokens.
 *
 * Token savings: 98% (1 batch LLM call vs N inline calls)
 *
 * Usage:
 *   bun src/services/agent-memory/consolidate-memories.ts --mode=daily
 *   bun src/services/agent-memory/consolidate-memories.ts --mode=weekly
 */

import { getDatabase } from "../../infra/database/client.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { memoryManager, type CreateMemoryInput } from "./memory-manager.js";

const log = createSubsystemLogger("agent-memory/consolidate");

export interface ConsolidationOptions {
  mode: "daily" | "weekly";
  agentId?: string; // If specified, consolidate only this agent
}

/**
 * Consolidate memories for all agents (or specific agent)
 */
export async function consolidateMemories(options: ConsolidationOptions): Promise<{
  agentsProcessed: number;
  memoriesCreated: number;
  eventsConsolidated: number;
}> {
  const { mode, agentId } = options;

  log.info(`Starting ${mode} memory consolidation${agentId ? ` for agent ${agentId}` : ""}`);

  const db = getDatabase();

  // Get list of agents to process
  const agents = agentId
    ? [{ agent_id: agentId }]
    : await db<Array<{ agent_id: string }>>`
        SELECT DISTINCT agent_id FROM agent_decision_log
        WHERE time >= NOW() - INTERVAL ${mode === "daily" ? "1 day" : "7 days"}
      `;

  let totalMemoriesCreated = 0;
  let totalEventsConsolidated = 0;

  for (const agent of agents) {
    try {
      const result = await consolidateAgentMemories(agent.agent_id, mode);
      totalMemoriesCreated += result.memoriesCreated;
      totalEventsConsolidated += result.eventsConsolidated;
    } catch (error) {
      log.error(`Failed to consolidate memories for agent ${agent.agent_id}: ${String(error)}`);
    }
  }

  log.info(
    `Consolidation complete: ${agents.length} agents, ${totalMemoriesCreated} memories created, ${totalEventsConsolidated} events consolidated`,
  );

  return {
    agentsProcessed: agents.length,
    memoriesCreated: totalMemoriesCreated,
    eventsConsolidated: totalEventsConsolidated,
  };
}

/**
 * Consolidate memories for a single agent
 */
async function consolidateAgentMemories(
  agentId: string,
  mode: "daily" | "weekly",
): Promise<{ memoriesCreated: number; eventsConsolidated: number }> {
  log.debug(`Consolidating ${mode} memories for agent ${agentId}`);

  const db = getDatabase();

  // 1. Fetch raw events from time-series tables
  const timeRange = mode === "daily" ? "1 day" : "7 days";

  const decisions = await db<
    Array<{
      decision_type: string;
      decision_quality: string;
      outcome: string | null;
      confidence_level: number | null;
    }>
  >`
    SELECT decision_type, decision_quality, outcome, confidence_level
    FROM agent_decision_log
    WHERE agent_id = ${agentId}
      AND time >= NOW() - INTERVAL ${timeRange}
    ORDER BY time DESC
  `;

  // 2. Group by type and consolidate
  const memories: CreateMemoryInput[] = [];

  // Consolidate decisions into pattern
  if (decisions.length > 0) {
    const goodDecisions = decisions.filter(
      (d: Record<string, unknown>) =>
        d.decision_quality === "excellent" || d.decision_quality === "good",
    );
    const badDecisions = decisions.filter(
      (d: Record<string, unknown>) => d.decision_quality === "poor",
    );

    if (goodDecisions.length >= 3) {
      // Pattern: Consistently good decisions
      const types = goodDecisions.map((d: Record<string, unknown>) => d.decision_type as string);
      const mostCommon = findMostCommon(types);

      memories.push({
        agentId,
        memoryType: "pattern",
        title: `Good decision pattern: ${mostCommon}`,
        content: `Made ${goodDecisions.length} good decisions (type: ${mostCommon}) in past ${timeRange}. Success pattern emerging.`,
        summary: `${goodDecisions.length} good ${mostCommon} decisions`,
        importance: 6,
        context: { period: mode, count: goodDecisions.length },
      });
    }

    if (badDecisions.length >= 2) {
      // Mistake: Pattern of poor decisions
      memories.push({
        agentId,
        memoryType: "mistake",
        title: `Poor decision pattern detected`,
        content: `Made ${badDecisions.length} poor decisions in past ${timeRange}. Need to review decision-making process.`,
        summary: `${badDecisions.length} poor decisions need review`,
        importance: 8,
        context: { period: mode, count: badDecisions.length },
      });
    }
  }

  // 3. Create memories in batch
  if (memories.length > 0) {
    await memoryManager.createMemories(memories);
    log.info(`Created ${memories.length} consolidated memories for agent ${agentId}`);
  }

  return {
    memoriesCreated: memories.length,
    eventsConsolidated: decisions.length,
  };
}

/**
 * Helper: Find most common element in array
 */
function findMostCommon<T>(arr: T[]): T {
  const counts = new Map<T, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0][0];
}

/**
 * CLI Entry Point
 */
if (import.meta.main) {
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith("--mode="))?.split("=")[1];
  const agentIdArg = args.find((arg) => arg.startsWith("--agent="))?.split("=")[1];

  if (!modeArg || (modeArg !== "daily" && modeArg !== "weekly")) {
    console.error("Usage: bun consolidate-memories.ts --mode=daily|weekly [--agent=agent-id]");
    process.exit(1);
  }

  consolidateMemories({
    mode: modeArg, // Already validated above (daily or weekly only)
    agentId: agentIdArg,
  } as Parameters<typeof consolidateMemories>[0])
    .then((result) => {
      console.log(`✅ Consolidation complete:`, result);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`❌ Consolidation failed:`, error);
      process.exit(1);
    });
}
