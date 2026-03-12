/**
 * OpenClaw Orchestrator - Phase 1 Core Architecture
 *
 * This is the main entry point for the new orchestrator system.
 * It combines:
 * - Task Router: classifies user requests
 * - Capability Registry: standardized tool schemas
 * - Short-term Memory: active context management
 * - Execution Engine: step execution with retry/rollback
 * - Memory Engine: episodic + semantic + policy memory
 */

export { TaskRouter, taskRouter, TaskCategory, TaskClassification } from './task-router.js';
export { CapabilityRegistry, capabilityRegistry, Capability, RiskLevel } from './capability-registry.js';
export { ShortTermMemory, shortTermMemory, MemoryEntry, TaskContext, TaskStep } from './short-term-memory.js';
export { ExecutionEngine, executionEngine, ActionRecord, ExecutionStatus } from './execution-engine.js';
export { MemoryEngine, memoryEngine, EpisodicMemoryEntry, SemanticMemoryEntry, PolicyMemoryEntry } from './memory-engine.js';

// Phase 2: Device Control & Repo Map
export { FileControl, AppControl, ClipboardControl, ProcessControl, ShellControl, WindowControl, fileControl, appControl, clipboardControl, processControl, shellControl, windowControl } from './device-control.js';
export { RepoMapBuilder, SymbolIndexer, PatchPlanner, repoMapBuilder, symbolIndexer, patchPlanner, FileNode, RepoMap, Symbol, SymbolIndex, Patch, PatchResult } from './repo-map.js';

/**
 * Main Orchestrator class that coordinates all components
 */
export class Orchestrator {
  private taskRouter;
  private capabilityRegistry;
  private shortTermMemory;
  private executionEngine;
  private memoryEngine;

  constructor() {
    this.taskRouter = new (await import('./task-router.js')).TaskRouter();
    this.capabilityRegistry = new (await import('./capability-registry.js')).CapabilityRegistry();
    this.shortTermMemory = new (await import('./short-term-memory.js')).ShortTermMemory();
    this.executionEngine = new (await import('./execution-engine.js')).ExecutionEngine(this.shortTermMemory);
    this.memoryEngine = new (await import('./memory-engine.js')).MemoryEngine();
  }

  /**
   * Process a user request through the full pipeline
   */
  async processRequest(userMessage: string): Promise<{
    classification: import('./task-router.js').TaskClassification;
    taskContext: import('./short-term-memory.js').TaskContext | null;
    result: unknown;
  }> {
    // Step 1: Classify the request
    const classification = this.taskRouter.classify(userMessage);

    // Step 2: Get suggested capabilities
    const capabilities = classification.suggestedCapabilities.map(name =>
      this.capabilityRegistry.get(name)
    ).filter(Boolean);

    // Step 3: Store in short-term memory
    this.shortTermMemory.addTurn('user', userMessage);

    // Step 4: Start task tracking
    const taskContext = this.shortTermMemory.startTask(
      userMessage,
      classification.category
    );

    // Step 5: Retrieve relevant memories
    const memories = await this.memoryEngine.retrieve({
      query: userMessage,
      limit: 5
    });

    // Return classification and context for the agent to use
    return {
      classification,
      taskContext,
      result: {
        capabilities,
        memories
      }
    };
  }
}

export default Orchestrator;
