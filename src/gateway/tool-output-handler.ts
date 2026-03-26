/**
 * Tool output handler: manages truncation policies for tool outputs
 * Allows specific tools to bypass truncation and return full output
 */

export interface ToolOutputPolicy {
  /** Tool name/id */
  toolName: string;
  /** Allow full output without truncation (default: false) */
  noTruncate?: boolean;
  /** Maximum tokens allowed (if not noTruncate); -1 means unlimited */
  maxTokens?: number;
  /** Enable streaming response for large outputs */
  streamable?: boolean;
}

const DEFAULT_POLICIES: Record<string, ToolOutputPolicy> = {
  read: {
    toolName: "read",
    noTruncate: true, // Full file contents without truncation
    streamable: true,
  },
  "config.get": {
    toolName: "config.get",
    noTruncate: true, // Full config without truncation
  },
  "memory_search": {
    toolName: "memory_search",
    noTruncate: true, // Full search results
  },
  "memory_get": {
    toolName: "memory_get",
    noTruncate: true, // Full memory contents
  },
  browse: {
    toolName: "browse",
    maxTokens: 50000, // Large but bounded for web content
    streamable: true,
  },
  "web.search": {
    toolName: "web.search",
    maxTokens: 10000, // Search results can be substantial
  },
  grep: {
    toolName: "grep",
    noTruncate: true, // Show all matches
  },
  glob: {
    toolName: "glob",
    noTruncate: true, // Show all file matches
  },
};

export class ToolOutputHandler {
  private policies: Map<string, ToolOutputPolicy>;

  constructor(customPolicies?: ToolOutputPolicy[]) {
    this.policies = new Map(Object.entries(DEFAULT_POLICIES));
    if (customPolicies) {
      for (const policy of customPolicies) {
        this.policies.set(policy.toolName, policy);
      }
    }
  }

  /**
   * Get output policy for a tool
   */
  getPolicy(toolName: string): ToolOutputPolicy | null {
    return this.policies.get(toolName) ?? null;
  }

  /**
   * Check if tool output should NOT be truncated
   */
  shouldNotTruncate(toolName: string): boolean {
    const policy = this.getPolicy(toolName);
    return policy?.noTruncate === true;
  }

  /**
   * Get max tokens for tool output
   */
  getMaxTokens(toolName: string): number | null {
    const policy = this.getPolicy(toolName);
    if (policy?.maxTokens === -1) {
      return null; // Unlimited
    }
    return policy?.maxTokens ?? 8000; // Default limit
  }

  /**
   * Check if tool supports streaming response
   */
  isStreamable(toolName: string): boolean {
    const policy = this.getPolicy(toolName);
    return policy?.streamable === true;
  }

  /**
   * Get all non-truncating tools
   */
  getFullOutputTools(): string[] {
    const tools: string[] = [];
    for (const [name, policy] of this.policies.entries()) {
      if (policy.noTruncate === true) {
        tools.push(name);
      }
    }
    return tools;
  }
}
