/**
 * Short-term Memory - *
 * This is Active context management
 the core of Phase 1: Architecture Core
 *
 * Manages:
 * - Current task
 * - Current step
 * - Current state
 * - 3-7 recent conversation turns
 * - Active context only
 */

export interface MemoryEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface TaskContext {
  taskId: string;
  task: string;
  category: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  steps: TaskStep[];
  currentStep: number;
  result?: unknown;
}

export interface TaskStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  capability?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ShortTermMemoryState {
  // Active context
  currentTask: TaskContext | null;
  recentTurns: MemoryEntry[];
  currentState: Record<string, unknown>;

  // Metadata
  lastUpdated: number;
  sessionId: string;
}

export interface ShortTermMemoryConfig {
  maxRecentTurns: number;
  maxStateSize: number;
  autoCompressThreshold: number;
}

const DEFAULT_CONFIG: ShortTermMemoryConfig = {
  maxRecentTurns: 7,
  maxStateSize: 1000,
  autoCompressThreshold: 5
};

export class ShortTermMemory {
  private state: ShortTermMemoryState;
  private config: ShortTermMemoryConfig;
  private listeners: Set<(state: ShortTermMemoryState) => void>;

  constructor(config: Partial<ShortTermMemoryConfig> = {}, sessionId: string = 'default') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.listeners = new Set();

    this.state = {
      currentTask: null,
      recentTurns: [],
      currentState: {},
      lastUpdated: Date.now(),
      sessionId
    };
  }

  /**
   * Subscribe to memory changes
   */
  subscribe(listener: (state: ShortTermMemoryState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Notify all listeners of state change
   */
  private notify(): void {
    this.state.lastUpdated = Date.now();
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  /**
   * Add a conversation turn
   */
  addTurn(role: 'user' | 'assistant' | 'system', content: string, metadata?: Record<string, unknown>): void {
    const entry: MemoryEntry = {
      id: `turn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role,
      content,
      timestamp: Date.now(),
      metadata
    };

    this.state.recentTurns.push(entry);

    // Keep only the most recent turns
    if (this.state.recentTurns.length > this.config.maxRecentTurns) {
      this.state.recentTurns = this.state.recentTurns.slice(-this.config.maxRecentTurns);
    }

    this.notify();
  }

  /**
   * Get recent turns (default: 3-7)
   */
  getRecentTurns(count?: number): MemoryEntry[] {
    const take = count || Math.min(5, this.config.maxRecentTurns);
    return this.state.recentTurns.slice(-take);
  }

  /**
   * Get all turns
   */
  getAllTurns(): MemoryEntry[] {
    return [...this.state.recentTurns];
  }

  /**
   * Start a new task
   */
  startTask(task: string, category: string): TaskContext {
    const taskContext: TaskContext = {
      taskId: `task_${Date.now()}`,
      task,
      category,
      status: 'in_progress',
      steps: [],
      currentStep: 0
    };

    this.state.currentTask = taskContext;
    this.notify();
    return taskContext;
  }

  /**
   * Add a step to current task
   */
  addStep(name: string, capability?: string, params?: Record<string, unknown>): TaskStep {
    if (!this.state.currentTask) {
      throw new Error('No active task');
    }

    const step: TaskStep = {
      id: `step_${Date.now()}`,
      name,
      status: 'pending',
      capability,
      params,
      startedAt: undefined,
      completedAt: undefined
    };

    this.state.currentTask.steps.push(step);
    this.notify();
    return step;
  }

  /**
   * Start executing a step
   */
  startStep(stepId: string): void {
    if (!this.state.currentTask) return;

    const step = this.state.currentTask.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'running';
      step.startedAt = Date.now();
      this.notify();
    }
  }

  /**
   * Complete a step
   */
  completeStep(stepId: string, result?: unknown): void {
    if (!this.state.currentTask) return;

    const step = this.state.currentTask.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'completed';
      step.result = result;
      step.completedAt = Date.now();
      this.state.currentTask.currentStep++;
      this.notify();
    }
  }

  /**
   * Fail a step
   */
  failStep(stepId: string, error: string): void {
    if (!this.state.currentTask) return;

    const step = this.state.currentTask.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'failed';
      step.error = error;
      step.completedAt = Date.now();
      this.notify();
    }
  }

  /**
   * Complete the current task
   */
  completeTask(result?: unknown): void {
    if (this.state.currentTask) {
      this.state.currentTask.status = 'completed';
      this.state.currentTask.result = result;
      this.notify();
    }
  }

  /**
   * Fail the current task
   */
  failTask(error: string): void {
    if (this.state.currentTask) {
      this.state.currentTask.status = 'failed';
      this.state.currentTask.result = { error };
      this.notify();
    }
  }

  /**
   * Get current task
   */
  getCurrentTask(): TaskContext | null {
    return this.state.currentTask;
  }

  /**
   * Get current step
   */
  getCurrentStep(): TaskStep | null {
    if (!this.state.currentTask) return null;
    return this.state.currentTask.steps[this.state.currentTask.currentStep] || null;
  }

  /**
   * Set state value
   */
  setState(key: string, value: unknown): void {
    this.state.currentState[key] = value;

    // Check if state is getting too large
    const stateSize = JSON.stringify(this.state.currentState).length;
    if (stateSize > this.config.maxStateSize) {
      console.warn('Short-term memory state is getting large, consider compressing');
    }

    this.notify();
  }

  /**
   * Get state value
   */
  getState(key: string): unknown {
    return this.state.currentState[key];
  }

  /**
   * Get all state
   */
  getAllState(): Record<string, unknown> {
    return { ...this.state.currentState };
  }

  /**
   * Clear state
   */
  clearState(): void {
    this.state.currentState = {};
    this.notify();
  }

  /**
   * Clear all memory
   */
  clear(): void {
    this.state = {
      currentTask: null,
      recentTurns: [],
      currentState: {},
      lastUpdated: Date.now(),
      sessionId: this.state.sessionId
    };
    this.notify();
  }

  /**
   * Get memory summary for context
   */
  getContextSummary(): string {
    const parts: string[] = [];

    // Current task
    if (this.state.currentTask) {
      parts.push(`Task: ${this.state.currentTask.task} (${this.state.currentTask.status})`);
      if (this.state.currentTask.steps.length > 0) {
        const completedSteps = this.state.currentTask.steps.filter(s => s.status === 'completed').length;
        parts.push(`Progress: ${completedSteps}/${this.state.currentTask.steps.length} steps`);
      }
    }

    // Recent turns count
    parts.push(`Recent turns: ${this.state.recentTurns.length}`);

    return parts.join('\n');
  }

  /**
   * Export memory for debugging
   */
  export(): ShortTermMemoryState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Import memory from export
   */
  import(data: ShortTermMemoryState): void {
    this.state = data;
    this.notify();
  }
}

// Default instance
export const shortTermMemory = new ShortTermMemory({}, 'default');

export default ShortTermMemory;
