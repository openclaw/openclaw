/**
 * ClawForge Orchestrator - 主节点实现
 * 
 * 负责任务拆分、Worker 管理和结果汇总
 */

import type { Task, Subtask, TaskStatus, WorkerInfo } from './types.js';
import { TaskSplitter } from './task-splitter.js';
import { WorkerManager } from './worker-manager.js';
import { ResultMerger } from './result-merger.js';

/**
 * Orchestrator 配置
 */
export interface OrchestratorConfig {
  maxWorkers: number;
  taskTimeout: number;        // 任务超时（毫秒）
  workerTimeout: number;      // Worker 心跳超时（毫秒）
  retryAttempts: number;
  enableLoadBalancing: boolean;
  enableProgressTracking: boolean;
}

/**
 * 主 OpenClaw（Orchestrator）
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private taskSplitter: TaskSplitter;
  private workerManager: WorkerManager;
  private resultMerger: ResultMerger;
  
  private activeTasks: Map<string, Task> = new Map();
  private taskQueue: Task[] = [];

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = {
      maxWorkers: config.maxWorkers || 50,
      taskTimeout: config.taskTimeout || 3600000,  // 1 小时
      workerTimeout: config.workerTimeout || 30000, // 30 秒
      retryAttempts: config.retryAttempts || 3,
      enableLoadBalancing: config.enableLoadBalancing ?? true,
      enableProgressTracking: config.enableProgressTracking ?? true,
    };

    this.taskSplitter = new TaskSplitter();
    this.workerManager = new WorkerManager(this.config);
    this.resultMerger = new ResultMerger();

    console.log(`[Orchestrator] 初始化完成，最大 Worker 数：${this.config.maxWorkers}`);
  }

  /**
   * 接收复杂任务
   */
  async submitTask(task: Task): Promise<string> {
    console.log(`[Orchestrator] 接收任务：${task.id} - ${task.description}`);
    
    // 1. 分析任务并拆分
    task.status = 'analyzing';
    this.activeTasks.set(task.id, task);

    try {
      // 2. 使用 AI 拆分任务
      const subtasks = await this.taskSplitter.splitTask(task);
      task.subtasks = subtasks;
      task.status = 'splitting';

      console.log(`[Orchestrator] 任务 ${task.id} 拆分为 ${subtasks.length} 个子任务`);

      // 3. 分配给 Worker
      task.status = 'executing';
      await this.assignSubtasks(task);

      return task.id;
    } catch (error) {
      console.error(`[Orchestrator] 任务拆分失败：${task.id}`, error);
      task.status = 'failed';
      task.error = `任务拆分失败：${error}`;
      throw error;
    }
  }

  /**
   * 分配子任务给 Worker
   */
  private async assignSubtasks(task: Task): Promise<void> {
    if (!task.subtasks) {
      throw new Error('任务未拆分');
    }

    for (const subtask of task.subtasks) {
      try {
        // 选择最合适的 Worker
        const worker = await this.workerManager.selectWorker(
          subtask,
          this.config.enableLoadBalancing
        );

        if (!worker) {
          // 没有可用 Worker，加入队列等待
          this.taskQueue.push(task);
          console.warn(`[Orchestrator] 没有可用 Worker，任务 ${task.id} 加入队列`);
          continue;
        }

        // 分配任务
        subtask.assignedTo = worker.id;
        subtask.status = 'assigned';

        await this.workerManager.assignTask(worker.id, subtask);
        console.log(`[Orchestrator] 子任务 ${subtask.id} 分配给 Worker ${worker.id}`);
      } catch (error) {
        console.error(`[Orchestrator] 分配子任务失败：${subtask.id}`, error);
        subtask.status = 'pending';  // 重新等待分配
      }
    }
  }

  /**
   * 处理 Worker 汇报的进度
   */
  async handleWorkerProgress(
    workerId: string,
    subtaskId: string,
    progress: number
  ): Promise<void> {
    const subtask = await this.findSubtask(subtaskId);
    if (!subtask) {
      console.warn(`[Orchestrator] 未找到子任务：${subtaskId}`);
      return;
    }

    subtask.progress = progress;
    
    // 更新父任务进度
    const parentTask = this.activeTasks.get(subtask.parentId);
    if (parentTask && this.config.enableProgressTracking) {
      parentTask.progress = this.calculateOverallProgress(parentTask);
      
      // 汇报进度（如果有外部监听器）
      this.emitProgressUpdate(parentTask);
    }
  }

  /**
   * 处理子任务完成
   */
  async handleSubtaskCompleted(
    workerId: string,
    subtaskId: string,
    result: any
  ): Promise<void> {
    const subtask = await this.findSubtask(subtaskId);
    if (!subtask) {
      console.warn(`[Orchestrator] 未找到子任务：${subtaskId}`);
      return;
    }

    console.log(`[Orchestrator] 子任务完成：${subtaskId}`);
    
    subtask.status = 'completed';
    subtask.result = result;

    // 检查父任务是否所有子任务都完成
    const parentTask = this.activeTasks.get(subtask.parentId);
    if (parentTask) {
      await this.checkTaskCompletion(parentTask);
    }
  }

  /**
   * 处理子任务失败
   */
  async handleSubtaskFailed(
    workerId: string,
    subtaskId: string,
    error: string
  ): Promise<void> {
    const subtask = await this.findSubtask(subtaskId);
    if (!subtask) {
      console.warn(`[Orchestrator] 未找到子任务：${subtaskId}`);
      return;
    }

    console.error(`[Orchestrator] 子任务失败：${subtaskId} - ${error}`);
    
    subtask.error = error;

    // 重试逻辑
    if (subtask.retryCount < this.config.retryAttempts) {
      subtask.retryCount++;
      subtask.status = 'retrying';
      console.log(`[Orchestrator] 重试子任务：${subtaskId} (第 ${subtask.retryCount} 次)`);
      
      // 重新分配
      await this.assignSubtasksToWorker(subtask);
    } else {
      subtask.status = 'failed';
      
      // 检查是否影响父任务
      const parentTask = this.activeTasks.get(subtask.parentId);
      if (parentTask) {
        await this.checkTaskCompletion(parentTask);
      }
    }
  }

  /**
   * 检查任务是否完成
   */
  private async checkTaskCompletion(task: Task): Promise<void> {
    if (!task.subtasks) return;

    const allCompleted = task.subtasks.every(st => st.status === 'completed');
    const hasFailed = task.subtasks.some(st => st.status === 'failed' && st.retryCount >= this.config.retryAttempts);

    if (allCompleted) {
      // 所有子任务完成，汇总结果
      task.status = 'merging';
      console.log(`[Orchestrator] 任务 ${task.id} 所有子任务完成，开始汇总结果`);

      try {
        const results = task.subtasks.map(st => st.result);
        task.result = await this.resultMerger.merge(results, task);
        task.status = 'completed';
        task.completedAt = Date.now();
        
        console.log(`[Orchestrator] 任务完成：${task.id}`);
        this.emitTaskCompleted(task);
      } catch (error) {
        console.error(`[Orchestrator] 结果汇总失败：${task.id}`, error);
        task.status = 'failed';
        task.error = `结果汇总失败：${error}`;
      }
    } else if (hasFailed) {
      // 有子任务失败且无法重试
      task.status = 'failed';
      task.error = '部分子任务失败';
      console.error(`[Orchestrator] 任务失败：${task.id}`);
      this.emitTaskFailed(task);
    }
  }

  /**
   * 计算总体进度
   */
  private calculateOverallProgress(task: Task): number {
    if (!task.subtasks || task.subtasks.length === 0) {
      return 0;
    }

    const totalWeight = task.subtasks.reduce((sum, st) => sum + (st.weight || 1), 0);
    const weightedProgress = task.subtasks.reduce((sum, st) => {
      return sum + (st.progress * (st.weight || 1));
    }, 0);

    return Math.round(weightedProgress / totalWeight);
  }

  /**
   * 查找子任务
   */
  private async findSubtask(subtaskId: string): Promise<Subtask | null> {
    for (const task of this.activeTasks.values()) {
      if (task.subtasks) {
        const subtask = task.subtasks.find(st => st.id === subtaskId);
        if (subtask) return subtask;
      }
    }
    return null;
  }

  /**
   * 重新分配子任务给 Worker
   */
  private async assignSubtasksToWorker(subtask: Subtask): Promise<void> {
    const worker = await this.workerManager.selectWorker(subtask, this.config.enableLoadBalancing);
    
    if (worker) {
      subtask.assignedTo = worker.id;
      subtask.status = 'assigned';
      await this.workerManager.assignTask(worker.id, subtask);
    } else {
      subtask.status = 'pending';
    }
  }

  /**
   * 获取任务进度
   */
  getTaskProgress(taskId: string): Task | undefined {
    return this.activeTasks.get(taskId);
  }

  /**
   * 获取所有活跃任务
   */
  getActiveTasks(): Task[] {
    return Array.from(this.activeTasks.values());
  }

  /**
   * 事件：进度更新
   */
  private emitProgressUpdate(task: Task): void {
    // 实际实现时应该通过 WebSocket 或回调通知客户端
    console.log(`[Orchestrator] 进度更新：${task.id} - ${task.progress}%`);
  }

  /**
   * 事件：任务完成
   */
  private emitTaskCompleted(task: Task): void {
    console.log(`[Orchestrator] 任务完成：${task.id}`);
    // 清理任务
    this.activeTasks.delete(task.id);
  }

  /**
   * 事件：任务失败
   */
  private emitTaskFailed(task: Task): void {
    console.error(`[Orchestrator] 任务失败：${task.id} - ${task.error}`);
    // 清理任务
    this.activeTasks.delete(task.id);
  }

  /**
   * 关闭 Orchestrator
   */
  async shutdown(): Promise<void> {
    console.log('[Orchestrator] 正在关闭...');
    
    // 等待所有任务完成或超时
    await this.workerManager.shutdown();
    
    console.log('[Orchestrator] 已关闭');
  }
}
