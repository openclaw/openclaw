import { logError } from "../logger.js";

interface GistFile {
  content: string;
}

interface GistResponse {
  files: Record<string, GistFile | undefined>;
}

interface HiveMindNode {
  last_seen: string;
  role: string;
  status: string;
}

interface HiveMindInsight {
  agent: string;
  timestamp: string;
  topic: string;
  content: string;
  tags: string[];
}

interface HiveMindState {
  active_nodes?: Record<string, HiveMindNode>;
  knowledge_base?: HiveMindInsight[];
}

/**
 * P2PManager: A TypeScript bridge for HiveMind signaling.
 * Enables official OpenCLAW nodes to participate in the decentralized P2P network.
 */
export class P2PManager {
  private agentName: string;
  private gistId: string;
  private token: string;

  constructor(agentName: string) {
    this.agentName = agentName;
    this.gistId = process.env.HIVEMIND_GIST_ID || "";
    this.token = process.env.GITHUB_TOKEN || "";
  }

  /**
   * Registers the agent's presence in the global HiveMind.
   */
  async registerPresence(): Promise<void> {
    if (!this.gistId || !this.token) {
      return;
    }

    try {
      const state = await this.readState();
      const nodes = state.active_nodes || {};
      nodes[this.agentName] = {
        last_seen: new Date().toISOString(),
        role: "Official-Node",
        status: "online",
      };
      state.active_nodes = nodes;
      await this.writeState(state);
    } catch (error) {
      logError(
        `P2P: Failed to register presence: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Publishes an insight to the global knowledge base.
   */
  async publishInsight(topic: string, content: string, tags: string[] = []): Promise<void> {
    if (!this.gistId || !this.token) {
      return;
    }

    try {
      const state = await this.readState();
      const insights = state.knowledge_base || [];
      insights.push({
        agent: this.agentName,
        timestamp: new Date().toISOString(),
        topic,
        content,
        tags,
      });
      state.knowledge_base = insights;
      await this.writeState(state);
    } catch (error) {
      logError(
        `P2P: Failed to publish insight: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readState(): Promise<HiveMindState> {
    const url = `https://api.github.com/gists/${this.gistId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!response.ok) {
      throw new Error(`State read failed: ${response.statusText}`);
    }
    const data = (await response.json()) as GistResponse;
    const content = data.files["hivemind_state.json"]?.content;
    return content ? (JSON.parse(content) as HiveMindState) : {};
  }

  private async writeState(state: HiveMindState): Promise<void> {
    const url = `https://api.github.com/gists/${this.gistId}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: {
          "hivemind_state.json": {
            content: JSON.stringify(state, null, 2),
          },
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`State write failed: ${response.statusText}`);
    }
  }
}
