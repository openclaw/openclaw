/**
 * Swarm Agents: Multi-agent collaboration for red team and blue team operations.
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { SwarmAgentConfig } from "../../config/types.security.js";
import type { AttackTest } from "../arr/index.js";
import type { ThreatDetectionResult } from "../cognitive-security/index.js";

export type SwarmMode = "sequential" | "parallel" | "consensus";
export type CommunicationProtocol = "broadcast" | "hierarchical" | "peer_to_peer";

export type RedTeamAgent = "attack_generator" | "payload_optimizer" | "evaluation_agent" | "coverage_analyst";
export type BlueTeamAgent = "threat_detector" | "defense_validator" | "risk_assessor" | "mitigation_planner";

export type SwarmMessage = {
  from: string;
  to: string[];
  type: "attack" | "defense" | "evaluation" | "coverage" | "threat" | "risk" | "mitigation";
  payload: unknown;
  timestamp: number;
};

export type SwarmResult = {
  agents: string[];
  mode: SwarmMode;
  messages: SwarmMessage[];
  consensus?: unknown;
  duration: number;
};

/**
 * Main Swarm Agents API
 */
export class SwarmAgents {
  private config: SwarmAgentConfig;
  private redTeamAgents: RedTeamAgent[] = [];
  private blueTeamAgents: BlueTeamAgent[] = [];
  private messages: SwarmMessage[] = [];

  constructor(config: SwarmAgentConfig) {
    this.config = config;
    
    if (config.redTeamSwarm?.enabled) {
      const defaultRedAgents: RedTeamAgent[] = [
        "attack_generator",
        "payload_optimizer",
        "evaluation_agent",
        "coverage_analyst",
      ];
      this.redTeamAgents = (config.redTeamSwarm.agents as RedTeamAgent[]) ?? defaultRedAgents;
    }

    if (config.blueTeamSwarm?.enabled) {
      const defaultBlueAgents: BlueTeamAgent[] = [
        "threat_detector",
        "defense_validator",
        "risk_assessor",
        "mitigation_planner",
      ];
      this.blueTeamAgents = (config.blueTeamSwarm.agents as BlueTeamAgent[]) ?? defaultBlueAgents;
    }
  }

  /**
   * Run red team swarm.
   */
  async runRedTeamSwarm(options: {
    testCount?: number;
  } = {}): Promise<SwarmResult> {
    if (!this.config.redTeamSwarm?.enabled) {
      throw new Error("Red team swarm not enabled");
    }

    const startTime = Date.now();
    const mode = this.config.collaboration?.defaultMode ?? "consensus";
    const agents = this.redTeamAgents;
    const messages: SwarmMessage[] = [];

    // Attack generation
    if (agents.includes("attack_generator")) {
      messages.push({
        from: "attack_generator",
        to: ["payload_optimizer", "evaluation_agent"],
        type: "attack",
        payload: { testCount: options.testCount ?? 10 },
        timestamp: Date.now(),
      });
    }

    // Payload optimization
    if (agents.includes("payload_optimizer")) {
      messages.push({
        from: "payload_optimizer",
        to: ["evaluation_agent"],
        type: "evaluation",
        payload: { optimized: true },
        timestamp: Date.now(),
      });
    }

    // Evaluation
    if (agents.includes("evaluation_agent")) {
      messages.push({
        from: "evaluation_agent",
        to: ["coverage_analyst"],
        type: "evaluation",
        payload: { results: [] },
        timestamp: Date.now(),
      });
    }

    // Coverage analysis
    if (agents.includes("coverage_analyst")) {
      messages.push({
        from: "coverage_analyst",
        to: [],
        type: "coverage",
        payload: { coverage: 0.75 },
        timestamp: Date.now(),
      });
    }

    this.messages.push(...messages);

    let consensus: unknown;
    if (mode === "consensus") {
      consensus = this.reachConsensus(messages);
    }

    return {
      agents,
      mode,
      messages,
      consensus,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Run blue team swarm.
   */
  async runBlueTeamSwarm(options: {
    threats?: ThreatDetectionResult[];
  } = {}): Promise<SwarmResult> {
    if (!this.config.blueTeamSwarm?.enabled) {
      throw new Error("Blue team swarm not enabled");
    }

    const startTime = Date.now();
    const mode = this.config.collaboration?.defaultMode ?? "consensus";
    const agents = this.blueTeamAgents;
    const messages: SwarmMessage[] = [];

    // Threat detection
    if (agents.includes("threat_detector")) {
      messages.push({
        from: "threat_detector",
        to: ["defense_validator", "risk_assessor"],
        type: "threat",
        payload: options.threats ?? [],
        timestamp: Date.now(),
      });
    }

    // Defense validation
    if (agents.includes("defense_validator")) {
      messages.push({
        from: "defense_validator",
        to: ["risk_assessor"],
        type: "defense",
        payload: { valid: true },
        timestamp: Date.now(),
      });
    }

    // Risk assessment
    if (agents.includes("risk_assessor")) {
      messages.push({
        from: "risk_assessor",
        to: ["mitigation_planner"],
        type: "risk",
        payload: { riskLevel: 0.5 },
        timestamp: Date.now(),
      });
    }

    // Mitigation planning
    if (agents.includes("mitigation_planner")) {
      messages.push({
        from: "mitigation_planner",
        to: [],
        type: "mitigation",
        payload: { plan: "Monitor and restrict" },
        timestamp: Date.now(),
      });
    }

    this.messages.push(...messages);

    let consensus: unknown;
    if (mode === "consensus") {
      consensus = this.reachConsensus(messages);
    }

    return {
      agents,
      mode,
      messages,
      consensus,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Reach consensus from swarm messages.
   */
  private reachConsensus(messages: SwarmMessage[]): unknown {
    // Simple consensus: aggregate payloads
    const aggregated: Record<string, unknown[]> = {};

    for (const msg of messages) {
      if (!aggregated[msg.type]) {
        aggregated[msg.type] = [];
      }
      aggregated[msg.type].push(msg.payload);
    }

    return aggregated;
  }

  /**
   * Run swarm vs swarm simulation.
   */
  async runSwarmVsSwarm(duration: number = 3600): Promise<{
    redTeam: SwarmResult;
    blueTeam: SwarmResult;
    winner?: "red" | "blue" | "draw";
  }> {
    if (!this.config.swarmVsSwarm?.enabled) {
      throw new Error("Swarm vs swarm not enabled");
    }

    const startTime = Date.now();
    const endTime = startTime + duration * 1000;

    const redResults: SwarmResult[] = [];
    const blueResults: SwarmResult[] = [];

    while (Date.now() < endTime) {
      const redResult = await this.runRedTeamSwarm({ testCount: 5 });
      const blueResult = await this.runBlueTeamSwarm();

      redResults.push(redResult);
      blueResults.push(blueResult);

      // Brief pause to avoid tight loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Determine winner (simplified)
    const redScore = redResults.reduce((sum, r) => sum + (r.consensus ? 1 : 0), 0);
    const blueScore = blueResults.reduce((sum, b) => sum + (b.consensus ? 1 : 0), 0);

    let winner: "red" | "blue" | "draw" | undefined;
    if (redScore > blueScore) {
      winner = "red";
    } else if (blueScore > redScore) {
      winner = "blue";
    } else {
      winner = "draw";
    }

    return {
      redTeam: redResults[redResults.length - 1] ?? {
        agents: this.redTeamAgents,
        mode: this.config.collaboration?.defaultMode ?? "consensus",
        messages: [],
        duration: 0,
      },
      blueTeam: blueResults[blueResults.length - 1] ?? {
        agents: this.blueTeamAgents,
        mode: this.config.collaboration?.defaultMode ?? "consensus",
        messages: [],
        duration: 0,
      },
      winner,
    };
  }

  /**
   * Get swarm messages.
   */
  getMessages(): SwarmMessage[] {
    return this.messages;
  }

  /**
   * Clear messages (for new simulation).
   */
  clearMessages(): void {
    this.messages = [];
  }

  /**
   * Check if Swarm Agents is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled === true;
  }
}

/**
 * Create Swarm Agents instance from config.
 */
export function createSwarmAgents(config: OpenClawConfig): SwarmAgents | null {
  const swarmAgents = config.security?.swarmAgents;
  if (!swarmAgents?.enabled) {
    return null;
  }
  return new SwarmAgents(swarmAgents);
}
