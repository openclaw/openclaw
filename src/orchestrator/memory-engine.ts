/**
 * Memory Engine - Episodic + Semantic Memory
 *
 * This is the core of Phase 1: Architecture Core
 *
 * Integrates with existing OpenClaw memory system
 * Provides:
 * - Episodic memory: session timelines with summaries
 * - Semantic memory: persistent knowledge about user, machine, rules
 * - Memory retrieval: hybrid search with metadata filtering
 * - Memory management: eviction, correction, ranking
 */

import { MemoryIndexManager, MemorySearchManager, SemanticMemoryEntry } from '../memory/manager.js';

export interface EpisodicMemoryEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  objective: string;
  obstacles: string[];
  successfulActions: string[];
  lessonsLearned: string[];
  summary: string;
  status: 'in_progress' | 'completed' | 'failed';
}

export interface SemanticMemoryEntry {
  id: string;
  type: 'user_preference' | 'machine_info' | 'rule' | 'habit' | 'account' | 'app' | 'general';
  content: string;
  metadata: {
    app?: string;
    domain?: string;
    confidence: number;
    lastUpdated: number;
    permissionLevel: 'public' | 'private' | 'sensitive';
  };
}

export interface PolicyMemoryEntry {
  id: string;
  type: 'permission' | 'denylist' | 'confirmation_required' | 'tool_whitelist';
  scope: string;
  action: string;
  level: 'auto_allow' | 'confirm_once' | 'confirm_always' | 'deny';
  createdAt: number;
  expiresAt?: number;
}

export interface MemoryRetrievalOptions {
  query: string;
  limit?: number;
  types?: ('episodic' | 'semantic' | 'policy')[];
  filters?: {
    app?: string;
    domain?: string;
    dateRange?: { start: number; end: number };
    riskLevel?: number;
    permissionLevel?: string;
  };
}

export interface MemoryRetrievalResult {
  episodic: EpisodicMemoryEntry[];
  semantic: SemanticMemoryEntry[];
  policy: PolicyMemoryEntry[];
  relevanceScores: Map<string, number>;
}

export class MemoryEngine {
  private episodicMemory: Map<string, EpisodicMemoryEntry>;
  private semanticMemory: Map<string, SemanticMemoryEntry>;
  private policyMemory: Map<string, PolicyMemoryEntry>;
  private existingMemoryManager?: MemoryIndexManager;

  constructor(existingMemoryManager?: MemoryIndexManager) {
    this.episodicMemory = new Map();
    this.semanticMemory = new Map();
    this.policyMemory = new Map();
    this.existingMemoryManager = existingMemoryManager;
  }

  // ============== EPISODIC MEMORY ==============

  /**
   * Create a new episodic memory entry for a session
   */
  createEpisodicEntry(sessionId: string, objective: string): EpisodicMemoryEntry {
    const entry: EpisodicMemoryEntry = {
      id: `episodic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      sessionId,
      timestamp: Date.now(),
      objective,
      obstacles: [],
      successfulActions: [],
      lessonsLearned: [],
      summary: '',
      status: 'in_progress'
    };

    this.episodicMemory.set(entry.id, entry);
    return entry;
  }

  /**
   * Add an obstacle encountered during session
   */
  addObstacle(episodicId: string, obstacle: string): void {
    const entry = this.episodicMemory.get(episodicId);
    if (entry) {
      entry.obstacles.push(obstacle);
    }
  }

  /**
   * Add a successful action
   */
  addSuccessfulAction(episodicId: string, action: string): void {
    const entry = this.episodicMemory.get(episodicId);
    if (entry) {
      entry.successfulActions.push(action);
    }
  }

  /**
   * Add a lesson learned
   */
  addLessonLearned(episodicId: string, lesson: string): void {
    const entry = this.episodicMemory.get(episodicId);
    if (entry) {
      entry.lessonsLearned.push(lesson);
    }
  }

  /**
   * Complete episodic memory with summary
   */
  completeEpisodic(episodicId: string, summary: string, status: 'completed' | 'failed'): void {
    const entry = this.episodicMemory.get(episodicId);
    if (entry) {
      entry.summary = summary;
      entry.status = status;
    }
  }

  /**
   * Get episodic memory by session
   */
  getEpisodicBySession(sessionId: string): EpisodicMemoryEntry[] {
    return Array.from(this.episodicMemory.values())
      .filter(entry => entry.sessionId === sessionId);
  }

  // ============== SEMANTIC MEMORY ==============

  /**
   * Store semantic memory
   */
  storeSemantic(type: SemanticMemoryEntry['type'], content: string, metadata: SemanticMemoryEntry['metadata']): SemanticMemoryEntry {
    const entry: SemanticMemoryEntry = {
      id: `semantic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      content,
      metadata
    };

    this.semanticMemory.set(entry.id, entry);
    return entry;
  }

  /**
   * Get semantic memories by type
   */
  getSemanticByType(type: SemanticMemoryEntry['type']): SemanticMemoryEntry[] {
    return Array.from(this.semanticMemory.values())
      .filter(entry => entry.type === type);
  }

  /**
   * Get user preferences
   */
  getUserPreferences(): SemanticMemoryEntry[] {
    return this.getSemanticByType('user_preference');
  }

  /**
   * Get machine info
   */
  getMachineInfo(): SemanticMemoryEntry[] {
    return this.getSemanticByType('machine_info');
  }

  /**
   * Get rules
   */
  getRules(): SemanticMemoryEntry[] {
    return this.getSemanticByType('rule');
  }

  // ============== POLICY MEMORY ==============

  /**
   * Store policy memory
   */
  storePolicy(type: PolicyMemoryEntry['type'], scope: string, action: string, level: PolicyMemoryEntry['level']): PolicyMemoryEntry {
    const entry: PolicyMemoryEntry = {
      id: `policy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      scope,
      action,
      level,
      createdAt: Date.now()
    };

    this.policyMemory.set(entry.id, entry);
    return entry;
  }

  /**
   * Get policy by scope and action
   */
  getPolicy(scope: string, action: string): PolicyMemoryEntry | undefined {
    return Array.from(this.policyMemory.values())
      .find(entry => entry.scope === scope && entry.action === action);
  }

  /**
   * Check if action requires confirmation
   */
  requiresConfirmation(scope: string, action: string): boolean {
    const policy = this.getPolicy(scope, action);
    return policy?.level === 'confirm_always' || policy?.level === 'confirm_once';
  }

  /**
   * Get all policies
   */
  getAllPolicies(): PolicyMemoryEntry[] {
    return Array.from(this.policyMemory.values());
  }

  // ============== MEMORY RETRIEVAL ==============

  /**
   * Retrieve memories based on query
   */
  async retrieve(options: MemoryRetrievalOptions): Promise<MemoryRetrievalResult> {
    const { query, limit = 5, types = ['episodic', 'semantic', 'policy'], filters } = options;

    const results: MemoryRetrievalResult = {
      episodic: [],
      semantic: [],
      policy: [],
      relevanceScores: new Map()
    };

    // Retrieve episodic memory
    if (types.includes('episodic')) {
      results.episodic = this.retrieveEpisodic(query, limit, filters);
    }

    // Retrieve semantic memory
    if (types.includes('semantic')) {
      results.semantic = this.retrieveSemantic(query, limit, filters);
    }

    // Retrieve policy memory
    if (types.includes('policy')) {
      results.policy = this.retrievePolicy(query, limit, filters);
    }

    return results;
  }

  /**
   * Simple keyword-based episodic retrieval
   */
  private retrieveEpisodic(query: string, limit: number, filters?: MemoryRetrievalOptions['filters']): EpisodicMemoryEntry[] {
    const queryLower = query.toLowerCase();
    let entries = Array.from(this.episodicMemory.values());

    // Apply filters
    if (filters?.dateRange) {
      entries = entries.filter(e =>
        e.timestamp >= filters.dateRange!.start &&
        e.timestamp <= filters.dateRange!.end
      );
    }

    // Score by keyword match
    const scored = entries.map(entry => {
      let score = 0;
      if (entry.objective.toLowerCase().includes(queryLower)) score += 2;
      if (entry.summary.toLowerCase().includes(queryLower)) score += 1;
      entry.successfulActions.forEach(a => {
        if (a.toLowerCase().includes(queryLower)) score += 0.5;
      });
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.entry);
  }

  /**
   * Simple keyword-based semantic retrieval
   */
  private retrieveSemantic(query: string, limit: number, filters?: MemoryRetrievalOptions['filters']): SemanticMemoryEntry[] {
    const queryLower = query.toLowerCase();
    let entries = Array.from(this.semanticMemory.values());

    // Apply filters
    if (filters?.app) {
      entries = entries.filter(e => e.metadata.app === filters.app);
    }
    if (filters?.domain) {
      entries = entries.filter(e => e.metadata.domain === filters.domain);
    }

    // Score by keyword match and confidence
    const scored = entries.map(entry => {
      let score = entry.metadata.confidence;
      if (entry.content.toLowerCase().includes(queryLower)) score += 1;
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.entry);
  }

  /**
   * Simple keyword-based policy retrieval
   */
  private retrievePolicy(query: string, limit: number, filters?: MemoryRetrievalOptions['filters']): PolicyMemoryEntry[] {
    const queryLower = query.toLowerCase();
    let entries = Array.from(this.policyMemory.values());

    // Score by keyword match
    const scored = entries.map(entry => {
      let score = 0;
      if (entry.scope.toLowerCase().includes(queryLower)) score += 1;
      if (entry.action.toLowerCase().includes(queryLower)) score += 1;
      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.entry);
  }

  // ============== MEMORY MANAGEMENT ==============

  /**
   * Evict memories that are old or low value
   */
  evict(maxAge: number = 30 * 24 * 60 * 60 * 1000, maxEntries: number = 1000): number {
    const now = Date.now();
    let evicted = 0;

    // Evict old episodic memories
    for (const [id, entry] of this.episodicMemory) {
      if (now - entry.timestamp > maxAge || this.episodicMemory.size > maxEntries) {
        this.episodicMemory.delete(id);
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * Correct outdated or incorrect memory
   */
  correctMemory(id: string, newContent: string): boolean {
    // Try episodic
    if (this.episodicMemory.has(id)) {
      const entry = this.episodicMemory.get(id)!;
      entry.summary = newContent;
      return true;
    }

    // Try semantic
    if (this.semanticMemory.has(id)) {
      const entry = this.semanticMemory.get(id)!;
      entry.content = newContent;
      entry.metadata.lastUpdated = Date.now();
      return true;
    }

    return false;
  }

  /**
   * Get memory statistics
   */
  getStats(): {
    episodicCount: number;
    semanticCount: number;
    policyCount: number;
    oldestEntry: number;
    newestEntry: number;
  } {
    const episodic = Array.from(this.episodicMemory.values());
    const timestamps = episodic.map(e => e.timestamp);

    return {
      episodicCount: this.episodicMemory.size,
      semanticCount: this.semanticMemory.size,
      policyCount: this.policyMemory.size,
      oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      newestEntry: timestamps.length > 0 ? Math.max(...timestamps) : 0
    };
  }

  /**
   * Export all memories
   */
  export(): {
    episodic: EpisodicMemoryEntry[];
    semantic: SemanticMemoryEntry[];
    policy: PolicyMemoryEntry[];
  } {
    return {
      episodic: Array.from(this.episodicMemory.values()),
      semantic: Array.from(this.semanticMemory.values()),
      policy: Array.from(this.policyMemory.values())
    };
  }

  /**
   * Import memories
   */
  import(data: {
    episodic?: EpisodicMemoryEntry[];
    semantic?: SemanticMemoryEntry[];
    policy?: PolicyMemoryEntry[];
  }): void {
    if (data.episodic) {
      data.episodic.forEach(e => this.episodicMemory.set(e.id, e));
    }
    if (data.semantic) {
      data.semantic.forEach(e => this.semanticMemory.set(e.id, e));
    }
    if (data.policy) {
      data.policy.forEach(e => this.policyMemory.set(e.id, e));
    }
  }
}

// Default instance
export const memoryEngine = new MemoryEngine();

export default MemoryEngine;
