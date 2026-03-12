/**
 * Execution Engine - Runs steps, logs actions, handles retry and rollback
 *
 * This is the core of Phase 1: Architecture Core
 *
 * Responsibilities:
 * - Execute steps quickly
 * - Call tools
 * - Collect state
 * - Report errors
 * - Verify results
 * - Handle retry and rollback
 */

import { capabilityRegistry, Capability } from './capability-registry.js';
import { ShortTermMemory, TaskStep, TaskContext } from './short-term-memory.js';

export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';

export interface ActionRecord {
  id: string;
  taskId: string;
  stepId: string;
  capability: string;
  params: Record<string, unknown>;
  status: ExecutionStatus;
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
  retries: number;
  verificationPassed?: boolean;
  verificationError?: string;
}

export interface RetryConfig {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

export interface ExecutionConfig {
  enableRetry: boolean;
  enableRollback: boolean;
  enableVerification: boolean;
  defaultTimeout: number;
  retryConfig: RetryConfig;
}

const DEFAULT_CONFIG: ExecutionConfig = {
  enableRetry: true,
  enableRollback: true,
  enableVerification: true,
  defaultTimeout: 30000,
  retryConfig: {
    maxRetries: 3,
    backoffMs: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['timeout', 'network', 'rate_limit']
  }
};

export class ExecutionEngine {
  private config: ExecutionConfig;
  private memory: ShortTermMemory;
  private actionLog: Map<string, ActionRecord>;
  private toolImplementations: Map<string, (params: Record<string, unknown>) => Promise<unknown>>;

  constructor(memory: ShortTermMemory, config: Partial<ExecutionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.memory = memory;
    this.actionLog = new Map();
    this.toolImplementations = new Map();
  }

  /**
   * Register a tool implementation
   */
  registerTool(name: string, implementation: (params: Record<string, unknown>) => Promise<unknown>): void {
    this.toolImplementations.set(name, implementation);
  }

  /**
   * Execute a single step
   */
  async executeStep(step: TaskStep): Promise<{ success: boolean; result?: unknown; error?: string }> {
    if (!step.capability) {
      return { success: false, error: 'No capability specified for step' };
    }

    const capability = capabilityRegistry.get(step.capability);
    if (!capability) {
      return { success: false, error: `Capability '${step.capability}' not found` };
    }

    // Validate parameters
    const validation = capabilityRegistry.validateCapability(step.capability, step.params || {});
    if (!validation.valid) {
      return { success: false, error: validation.errors.join(', ') };
    }

    // Create action record
    const record: ActionRecord = {
      id: `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      taskId: this.memory.getCurrentTask()?.taskId || 'unknown',
      stepId: step.id,
      capability: step.capability,
      params: step.params || {},
      status: 'running',
      startedAt: Date.now(),
      retries: 0
    };

    this.actionLog.set(record.id, record);
    this.memory.startStep(step.id);

    try {
      // Execute with retry
      const result = await this.executeWithRetry(record, capability);

      // Verify result if enabled
      if (this.config.enableVerification && result) {
        const verification = await this.verifyResult(record, capability);
        if (!verification.passed) {
          record.verificationPassed = false;
          record.verificationError = verification.error;
          throw new Error(`Verification failed: ${verification.error}`);
        }
        record.verificationPassed = true;
      }

      record.status = 'completed';
      record.result = result;
      record.completedAt = Date.now();

      this.memory.completeStep(step.id, result);

      return { success: true, result };

    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = Date.now();

      this.memory.failStep(step.id, record.error);

      return { success: false, error: record.error };
    }
  }

  /**
   * Execute with retry logic
   */
  private async executeWithRetry(record: ActionRecord, capability: Capability): Promise<unknown> {
    const toolImpl = this.toolImplementations.get(capability.name);
    if (!toolImpl) {
      throw new Error(`No implementation registered for capability '${capability.name}'`);
    }

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= this.config.retryConfig.maxRetries) {
      attempt++;
      record.retries = attempt - 1;

      try {
        const result = await this.executeWithTimeout(toolImpl, record.params, this.config.defaultTimeout);
        return result;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable
        const isRetryable = this.config.retryConfig.retryableErrors.some(
          e => lastError.message.toLowerCase().includes(e.toLowerCase())
        );

        if (!isRetryable || attempt > this.config.retryConfig.maxRetries) {
          throw lastError;
        }

        // Wait with exponential backoff
        const backoffTime = this.config.retryConfig.backoffMs *
          Math.pow(this.config.retryConfig.backoffMultiplier, attempt - 1);
        console.log(`Retrying after ${backoffTime}ms (attempt ${attempt}/${this.config.retryConfig.maxRetries})`);
        await this.sleep(backoffTime);
      }
    }

    throw lastError;
  }

  /**
   * Execute with timeout
   */
  private executeWithTimeout(
    fn: (params: Record<string, unknown>) => Promise<unknown>,
    params: Record<string, unknown>,
    timeout: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Execution timeout after ${timeout}ms`));
      }, timeout);

      fn(params)
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Verify execution result
   */
  private async verifyResult(record: ActionRecord, capability: Capability): Promise<{
    passed: boolean;
    error?: string;
  }> {
    // Simple verification based on capability
    // In production, this would be more sophisticated
    if (!record.result) {
      return { passed: false, error: 'No result returned' };
    }

    // Check for error indicators in result
    const resultStr = JSON.stringify(record.result).toLowerCase();
    if (resultStr.includes('error') || resultStr.includes('failed')) {
      return { passed: false, error: 'Result contains error indicator' };
    }

    return { passed: true };
  }

  /**
   * Rollback a step (if supported)
   */
  async rollbackStep(actionId: string): Promise<{ success: boolean; error?: string }> {
    const record = this.actionLog.get(actionId);
    if (!record) {
      return { success: false, error: 'Action not found' };
    }

    if (record.status !== 'failed') {
      return { success: false, error: 'Can only rollback failed actions' };
    }

    // In production, would implement actual rollback logic
    // For now, just mark as rolled back
    record.status = 'rolled_back';
    record.completedAt = Date.now();

    return { success: true };
  }

  /**
   * Get action history for a task
   */
  getActionHistory(taskId: string): ActionRecord[] {
    return Array.from(this.actionLog.values())
      .filter(record => record.taskId === taskId);
  }

  /**
   * Get action by ID
   */
  getAction(actionId: string): ActionRecord | undefined {
    return this.actionLog.get(actionId);
  }

  /**
   * Get all actions
   */
  getAllActions(): ActionRecord[] {
    return Array.from(this.actionLog.values());
  }

  /**
   * Clear action log
   */
  clearHistory(): void {
    this.actionLog.clear();
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Export action log for debugging
   */
  exportLog(): string {
    const records = Array.from(this.actionLog.values());
    return JSON.stringify(records, null, 2);
  }
}

// Default instance
export const executionEngine = new ExecutionEngine(new ShortTermMemory());

export default ExecutionEngine;
