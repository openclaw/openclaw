/**
 * Collaboration protocols for swarm agents.
 */

import type { SwarmMode, CommunicationProtocol, SwarmMessage } from "./index.js";

/**
 * Broadcast communication: send message to all agents.
 */
export function broadcastMessage(
  from: string,
  message: Omit<SwarmMessage, "from" | "to" | "timestamp">,
  allAgents: string[],
): SwarmMessage {
  return {
    from,
    to: allAgents.filter((a) => a !== from),
    type: message.type,
    payload: message.payload,
    timestamp: Date.now(),
  };
}

/**
 * Hierarchical communication: send message up/down the hierarchy.
 */
export function hierarchicalMessage(
  from: string,
  message: Omit<SwarmMessage, "from" | "to" | "timestamp">,
  hierarchy: Record<string, string[]>, // agent -> subordinates
): SwarmMessage[] {
  const messages: SwarmMessage[] = [];
  
  // Send to subordinates
  const subordinates = hierarchy[from] ?? [];
  if (subordinates.length > 0) {
    messages.push({
      from,
      to: subordinates,
      type: message.type,
      payload: message.payload,
      timestamp: Date.now(),
    });
  }

  // Send to superior (find who has this agent as subordinate)
  for (const [superior, subs] of Object.entries(hierarchy)) {
    if (subs.includes(from)) {
      messages.push({
        from,
        to: [superior],
        type: message.type,
        payload: message.payload,
        timestamp: Date.now(),
      });
      break;
    }
  }

  return messages;
}

/**
 * Peer-to-peer communication: send message to specific peers.
 */
export function peerToPeerMessage(
  from: string,
  message: Omit<SwarmMessage, "from" | "to" | "timestamp">,
  peers: string[],
): SwarmMessage {
  return {
    from,
    to: peers.filter((p) => p !== from),
    type: message.type,
    payload: message.payload,
    timestamp: Date.now(),
  };
}

/**
 * Execute swarm in sequential mode.
 */
export async function executeSequential(
  agents: string[],
  executeFn: (agent: string) => Promise<unknown>,
): Promise<unknown[]> {
  const results: unknown[] = [];
  
  for (const agent of agents) {
    const result = await executeFn(agent);
    results.push(result);
  }
  
  return results;
}

/**
 * Execute swarm in parallel mode.
 */
export async function executeParallel(
  agents: string[],
  executeFn: (agent: string) => Promise<unknown>,
): Promise<unknown[]> {
  const promises = agents.map((agent) => executeFn(agent));
  return Promise.all(promises);
}

/**
 * Execute swarm in consensus mode.
 */
export async function executeConsensus(
  agents: string[],
  executeFn: (agent: string) => Promise<unknown>,
  consensusFn: (results: unknown[]) => unknown,
): Promise<unknown> {
  const results = await executeParallel(agents, executeFn);
  return consensusFn(results);
}

/**
 * Simple consensus function: majority vote or average.
 */
export function simpleConsensus(results: unknown[]): unknown {
  if (results.length === 0) {
    return null;
  }

  // If all results are the same, return it
  const first = results[0];
  if (results.every((r) => r === first)) {
    return first;
  }

  // If results are numbers, return average
  const numbers = results.filter((r) => typeof r === "number") as number[];
  if (numbers.length === results.length && numbers.length > 0) {
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  }

  // Otherwise return first result
  return first;
}
