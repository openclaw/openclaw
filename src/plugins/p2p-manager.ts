import axios from 'axios';

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
    this.gistId = process.env.HIVEMIND_GIST_ID || '';
    this.token = process.env.GITHUB_TOKEN || '';
  }

  /**
   * Registers the agent's presence in the global HiveMind.
   */
  async registerPresence(): Promise<void> {
    if (!this.gistId || !this.token) return;

    try {
      const state = await this.readState();
      const nodes = state.active_nodes || {};
      nodes[this.agentName] = {
        last_seen: new Date().toISOString(),
        role: 'Official-Node',
        status: 'online'
      };
      state.active_nodes = nodes;
      await this.writeState(state);
    } catch (error) {
      console.error('P2P: Failed to register presence', error);
    }
  }

  /**
   * Publishes an insight to the global knowledge base.
   */
  async publishInsight(topic: string, content: string, tags: string[] = []): Promise<void> {
    if (!this.gistId || !this.token) return;

    try {
      const state = await this.readState();
      const insights = state.knowledge_base || [];
      insights.push({
        agent: this.agentName,
        timestamp: new Date().toISOString(),
        topic,
        content,
        tags
      });
      state.knowledge_base = insights;
      await this.writeState(state);
    } catch (error) {
      console.error('P2P: Failed to publish insight', error);
    }
  }

  private async readState(): Promise<any> {
    const url = `https://api.github.com/gists/${this.gistId}`;
    const response = await axios.get(url, {
      headers: { Authorization: `token ${this.token}` }
    });
    const content = response.data.files['hivemind_state.json']?.content;
    return content ? JSON.parse(content) : {};
  }

  private async writeState(state: any): Promise<void> {
    const url = `https://api.github.com/gists/${this.gistId}`;
    await axios.patch(url, {
      files: {
        'hivemind_state.json': {
          content: JSON.stringify(state, null, 2)
        }
      }
    }, {
      headers: { Authorization: `token ${this.token}` }
    });
  }
}
