import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentHQHistoryResult,
  AgentHQStatsResult,
  AgentHQDiffResult,
  AgentHQAgentInfo,
  AgentHQViewMode,
  AgentHQSummary,
} from "../types.ts";

export type AgentHQState = {
  client: GatewayBrowserClient | null;
  connected: boolean;

  // Loading states
  agenthqLoading: boolean;
  agenthqHistoryLoading: boolean;
  agenthqStatsLoading: boolean;
  agenthqDiffLoading: boolean;
  agenthqSummaryLoading: boolean;

  // Error states
  agenthqError: string | null;

  // Data
  agenthqAgents: AgentHQAgentInfo[];
  agenthqSelectedAgentId: string | null;
  agenthqHistory: AgentHQHistoryResult | null;
  agenthqStats: AgentHQStatsResult | null;
  agenthqDiff: AgentHQDiffResult | null;
  agenthqSummaries: Map<string, AgentHQSummary>;

  // UI state
  agenthqViewMode: AgentHQViewMode;
  agenthqSelectedCommit: string | null;
  agenthqSelectedFile: string | null;
  agenthqFileFilter: string[];
  agenthqExpandedCommits: Set<string>;
  agenthqSummaryEnabled: boolean;
  agenthqSummaryModel: string | null;
  agenthqSummaryProvider: string | null;
};

export function getInitialAgentHQState(): Partial<AgentHQState> {
  return {
    agenthqLoading: false,
    agenthqHistoryLoading: false,
    agenthqStatsLoading: false,
    agenthqDiffLoading: false,
    agenthqSummaryLoading: false,
    agenthqError: null,
    agenthqAgents: [],
    agenthqSelectedAgentId: null,
    agenthqHistory: null,
    agenthqStats: null,
    agenthqDiff: null,
    agenthqSummaries: new Map(),
    agenthqViewMode: "visual",
    agenthqSelectedCommit: null,
    agenthqSelectedFile: null,
    agenthqFileFilter: [],
    agenthqExpandedCommits: new Set(),
    agenthqSummaryEnabled: false,
    agenthqSummaryModel: null,
    agenthqSummaryProvider: null,
  };
}

/**
 * Load all agents with their AgentHQ info
 */
export async function loadAgentHQAgents(state: AgentHQState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.agenthqLoading) {
    return;
  }
  state.agenthqLoading = true;
  state.agenthqError = null;
  try {
    const res = await state.client.request<{ agents: AgentHQAgentInfo[] }>(
      "agenthq.agents.list",
      {},
    );
    if (res) {
      state.agenthqAgents = res.agents;
      // Auto-select first agent if none selected
      if (!state.agenthqSelectedAgentId && res.agents.length > 0) {
        state.agenthqSelectedAgentId = res.agents[0].agentId;
      }
    }
  } catch (err) {
    state.agenthqError = String(err);
  } finally {
    state.agenthqLoading = false;
  }
}

/**
 * Load git history for the selected agent
 */
export async function loadAgentHQHistory(
  state: AgentHQState,
  options?: { limit?: number; offset?: number; fileFilter?: string[] },
) {
  if (!state.client || !state.connected || !state.agenthqSelectedAgentId) {
    return;
  }
  if (state.agenthqHistoryLoading) {
    return;
  }
  state.agenthqHistoryLoading = true;
  state.agenthqError = null;
  try {
    const res = await state.client.request<AgentHQHistoryResult>("agenthq.history.list", {
      agentId: state.agenthqSelectedAgentId,
      limit: options?.limit ?? 100,
      offset: options?.offset ?? 0,
      files: options?.fileFilter ?? state.agenthqFileFilter,
    });
    if (res) {
      state.agenthqHistory = res;
    }
  } catch (err) {
    state.agenthqError = String(err);
  } finally {
    state.agenthqHistoryLoading = false;
  }
}

/**
 * Load stats for the selected agent
 */
export async function loadAgentHQStats(state: AgentHQState) {
  if (!state.client || !state.connected || !state.agenthqSelectedAgentId) {
    return;
  }
  if (state.agenthqStatsLoading) {
    return;
  }
  state.agenthqStatsLoading = true;
  state.agenthqError = null;
  try {
    const res = await state.client.request<AgentHQStatsResult>("agenthq.history.stats", {
      agentId: state.agenthqSelectedAgentId,
      files: state.agenthqFileFilter,
    });
    if (res) {
      state.agenthqStats = res;
    }
  } catch (err) {
    state.agenthqError = String(err);
  } finally {
    state.agenthqStatsLoading = false;
  }
}

/**
 * Load diff for a specific commit and file
 */
export async function loadAgentHQDiff(state: AgentHQState, sha: string, fileName: string) {
  if (!state.client || !state.connected || !state.agenthqSelectedAgentId) {
    return;
  }
  if (state.agenthqDiffLoading) {
    return;
  }
  state.agenthqDiffLoading = true;
  state.agenthqError = null;
  state.agenthqSelectedCommit = sha;
  state.agenthqSelectedFile = fileName;
  try {
    const res = await state.client.request<AgentHQDiffResult>("agenthq.history.diff", {
      agentId: state.agenthqSelectedAgentId,
      sha,
      fileName,
    });
    if (res) {
      state.agenthqDiff = res;
    }
  } catch (err) {
    state.agenthqError = String(err);
  } finally {
    state.agenthqDiffLoading = false;
  }
}

/**
 * Generate or retrieve a cached LLM summary for a commit
 */
export async function loadAgentHQSummary(state: AgentHQState, sha: string): Promise<void> {
  if (!state.client || !state.connected || !state.agenthqSelectedAgentId) {
    return;
  }
  // Check cache first
  if (state.agenthqSummaries.has(sha)) {
    return;
  }
  if (state.agenthqSummaryLoading) {
    return;
  }
  if (!state.agenthqSummaryModel || !state.agenthqSummaryProvider) {
    return;
  }
  state.agenthqSummaryLoading = true;
  try {
    const res = await state.client.request<AgentHQSummary>("agenthq.summary.generate", {
      agentId: state.agenthqSelectedAgentId,
      sha,
      model: state.agenthqSummaryModel,
      provider: state.agenthqSummaryProvider,
    });
    if (res) {
      state.agenthqSummaries.set(sha, res);
    }
  } catch (err) {
    console.error("Failed to load summary:", err);
  } finally {
    state.agenthqSummaryLoading = false;
  }
}

/**
 * Set the current view mode
 */
export function setAgentHQViewMode(state: AgentHQState, mode: AgentHQViewMode) {
  state.agenthqViewMode = mode;
}

/**
 * Select an agent and load its data
 */
export async function selectAgentHQAgent(state: AgentHQState, agentId: string) {
  state.agenthqSelectedAgentId = agentId;
  state.agenthqHistory = null;
  state.agenthqStats = null;
  state.agenthqDiff = null;
  state.agenthqSelectedCommit = null;
  state.agenthqSelectedFile = null;
  state.agenthqExpandedCommits.clear();

  // Load data for new agent
  await Promise.all([loadAgentHQHistory(state), loadAgentHQStats(state)]);
}

/**
 * Toggle expanded state for a commit in timeline view
 */
export function toggleAgentHQCommitExpanded(state: AgentHQState, sha: string) {
  if (state.agenthqExpandedCommits.has(sha)) {
    state.agenthqExpandedCommits.delete(sha);
  } else {
    state.agenthqExpandedCommits.add(sha);
  }
}

/**
 * Set file filter and reload history
 */
export async function setAgentHQFileFilter(state: AgentHQState, files: string[]) {
  state.agenthqFileFilter = files;
  await loadAgentHQHistory(state);
}

/**
 * Enable or disable LLM summaries
 */
export function setAgentHQSummaryEnabled(state: AgentHQState, enabled: boolean) {
  state.agenthqSummaryEnabled = enabled;
}

/**
 * Set the LLM model and provider for summaries
 */
export function setAgentHQSummaryModel(
  state: AgentHQState,
  model: string | null,
  provider: string | null,
) {
  state.agenthqSummaryModel = model;
  state.agenthqSummaryProvider = provider;
}
