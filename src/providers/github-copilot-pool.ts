/**
 * Multi-account token pool for GitHub Copilot
 * Implements round-robin load balancing across multiple accounts
 */

import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { CachedCopilotToken } from "./github-copilot-token.js";
import { resolveCopilotApiToken, deriveCopilotApiBaseUrlFromToken } from "./github-copilot-token.js";

export type AccountConfig = {
  name: string;
  token: string;
  priority?: number;
  enabled?: boolean;
};

export type AccountState = {
  name: string;
  githubToken: string;
  cachedToken?: CachedCopilotToken;
  usage: {
    requestCount: number;
    lastUsed: number;
    rateLimitRemaining?: number;
  };
  enabled: boolean;
};

export type PoolStats = {
  totalAccounts: number;
  enabledAccounts: number;
  combinedRequests: number;
  accounts: Array<{
    name: string;
    requestCount: number;
    lastUsed: number;
    enabled: boolean;
  }>;
};

type LoadBalanceStrategy = "round-robin" | "least-used" | "priority-fallover";

export class CopilotTokenPool {
  private accounts: Map<string, AccountState>;
  private strategy: LoadBalanceStrategy;
  private currentIndex: number = 0;
  private env: NodeJS.ProcessEnv;
  private statePath: string;

  constructor(params: {
    accounts: AccountConfig[];
    strategy?: LoadBalanceStrategy;
    env?: NodeJS.ProcessEnv;
  }) {
    this.accounts = new Map();
    this.strategy = params.strategy ?? "round-robin";
    this.env = params.env ?? process.env;
    this.statePath = path.join(resolveStateDir(this.env), "credentials", "github-copilot-pool.json");

    // Initialize accounts
    for (const config of params.accounts) {
      const enabled = config.enabled ?? true;
      this.accounts.set(config.name, {
        name: config.name,
        githubToken: config.token,
        enabled,
        usage: {
          requestCount: 0,
          lastUsed: 0,
        },
      });
    }

    // Load persisted state if exists
    this.loadState();
  }

  /**
   * Get the next token using the configured load balancing strategy
   */
  async getNextToken(): Promise<{
    token: string;
    baseUrl: string;
    accountName: string;
    expiresAt: number;
  }> {
    const enabledAccounts = Array.from(this.accounts.values()).filter((a) => a.enabled);
    
    if (enabledAccounts.length === 0) {
      throw new Error("No enabled GitHub Copilot accounts available");
    }

    let selectedAccount: AccountState;

    switch (this.strategy) {
      case "round-robin":
        selectedAccount = this.selectRoundRobin(enabledAccounts);
        break;
      case "least-used":
        selectedAccount = this.selectLeastUsed(enabledAccounts);
        break;
      case "priority-fallover":
        selectedAccount = this.selectPriorityFailover(enabledAccounts);
        break;
      default:
        selectedAccount = enabledAccounts[0];
    }

    // Get/refresh the Copilot API token for this account
    const cachePath = this.getAccountCachePath(selectedAccount.name);
    const result = await resolveCopilotApiToken({
      githubToken: selectedAccount.githubToken,
      env: this.env,
      cachePath,
    });

    // Update usage stats
    selectedAccount.usage.requestCount++;
    selectedAccount.usage.lastUsed = Date.now();
    this.saveState();

    return {
      token: result.token,
      baseUrl: result.baseUrl,
      accountName: selectedAccount.name,
      expiresAt: result.expiresAt,
    };
  }

  /**
   * Round-robin: cycle through accounts in order
   */
  private selectRoundRobin(accounts: AccountState[]): AccountState {
    const selected = accounts[this.currentIndex % accounts.length];
    this.currentIndex = (this.currentIndex + 1) % accounts.length;
    return selected;
  }

  /**
   * Least-used: pick account with lowest request count
   */
  private selectLeastUsed(accounts: AccountState[]): AccountState {
    return accounts.reduce((min, account) => 
      account.usage.requestCount < min.usage.requestCount ? account : min
    );
  }

  /**
   * Priority failover: use highest priority, fallback if rate limited
   * TODO: Implement rate limit detection
   */
  private selectPriorityFailover(accounts: AccountState[]): AccountState {
    // For now, just return first account
    // Will implement proper rate limit handling later
    return accounts[0];
  }

  /**
   * Get usage statistics across all accounts
   */
  getUsageStats(): PoolStats {
    const allAccounts = Array.from(this.accounts.values());
    const enabledAccounts = allAccounts.filter((a) => a.enabled);
    const combinedRequests = allAccounts.reduce((sum, a) => sum + a.usage.requestCount, 0);

    return {
      totalAccounts: allAccounts.length,
      enabledAccounts: enabledAccounts.length,
      combinedRequests,
      accounts: allAccounts.map((a) => ({
        name: a.name,
        requestCount: a.usage.requestCount,
        lastUsed: a.usage.lastUsed,
        enabled: a.enabled,
      })),
    };
  }

  /**
   * Refresh token for a specific account
   */
  async refreshToken(accountName: string): Promise<void> {
    const account = this.accounts.get(accountName);
    if (!account) {
      throw new Error(`Account ${accountName} not found in pool`);
    }

    const cachePath = this.getAccountCachePath(accountName);
    await resolveCopilotApiToken({
      githubToken: account.githubToken,
      env: this.env,
      cachePath,
    });
  }

  /**
   * Enable/disable an account without removing it
   */
  setAccountEnabled(accountName: string, enabled: boolean): void {
    const account = this.accounts.get(accountName);
    if (!account) {
      throw new Error(`Account ${accountName} not found in pool`);
    }
    account.enabled = enabled;
    this.saveState();
  }

  /**
   * Get cache path for a specific account
   */
  private getAccountCachePath(accountName: string): string {
    return path.join(
      resolveStateDir(this.env),
      "credentials",
      `github-copilot.${accountName}.token.json`
    );
  }

  /**
   * Load persisted usage state
   */
  private loadState(): void {
    try {
      const state = loadJsonFile(this.statePath) as any;
      if (state?.accounts && Array.isArray(state.accounts)) {
        for (const accountState of state.accounts) {
          const account = this.accounts.get(accountState.name);
          if (account) {
            account.usage = accountState.usage ?? account.usage;
          }
        }
      }
      if (typeof state?.currentIndex === "number") {
        this.currentIndex = state.currentIndex;
      }
    } catch {
      // State file doesn't exist or is invalid, use defaults
    }
  }

  /**
   * Save usage state to disk
   */
  private saveState(): void {
    const state = {
      currentIndex: this.currentIndex,
      accounts: Array.from(this.accounts.values()).map((a) => ({
        name: a.name,
        usage: a.usage,
      })),
    };
    saveJsonFile(this.statePath, state);
  }
}
