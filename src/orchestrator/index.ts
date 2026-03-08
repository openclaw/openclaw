/**
 * ClawForge Orchestrator-Worker 模块
 * 
 * 支持主从架构，实现任务拆分、并行执行和结果汇总
 */

export { Orchestrator } from './orchestrator.js';
export { Worker, createWorker } from './worker.js';
export { TaskSplitter } from './task-splitter.js';
export { WorkerManager } from './worker-manager.js';
export { ResultMerger } from './result-merger.js';

export type {
  Task,
  Subtask,
  TaskStatus,
  SubtaskStatus,
  WorkerInfo,
  Heartbeat,
  WorkerCommand,
  WorkerResponse,
  OrchestratorConfig,
  WorkerConfig,
} from './types.js';
