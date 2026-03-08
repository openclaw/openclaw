/**
 * Worker 管理器 - 管理 Worker 池和任务分配
 */

import type { Subtask, WorkerInfo, Heartbeat, WorkerCommand, WorkerResponse } from './types.js';
import type { OrchestratorConfig } from './orchestrator.js';

/**
 * Worker 管理器
 */
export class WorkerManager {
  private config: OrchestratorConfig;
  private workers: Map<string, WorkerInfo> = new Map();
  private pendingTasks: Map<string, Subtask> = new Map();
  private heartbeatTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  /**
   * 注册 Worker
   */
  registerWorker(workerId: string): void {
    const worker: WorkerInfo = {
      id: workerId,
      status: 'idle',
      resourceUsage: {
        cpu: 0,
        memory: 0,
        disk: 0,
      },
      lastHeartbeat: Date.now(),
    };

    this.workers.set(workerId, worker);
    console.log(`[WorkerManager] Worker 注册：${workerId}`);
  }

  /**
   * 注销 Worker
   */
  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
    
    // 清理心跳超时
    const timeout = this.heartbeatTimeouts.get(workerId);
    if (timeout) {
      clearTimeout(timeout);
      this.heartbeatTimeouts.delete(workerId);
    }

    console.log(`[WorkerManager] Worker 注销：${workerId}`);
  }

  /**
   * 处理 Worker 心跳
   */
  handleHeartbeat(heartbeat: Heartbeat): void {
    const worker = this.workers.get(heartbeat.workerId);
    
    if (!worker) {
      // 自动注册新 Worker
      this.registerWorker(heartbeat.workerId);
      return;
    }

    // 更新 Worker 状态
    worker.status = heartbeat.status;
    worker.currentTaskId = heartbeat.currentTaskId;
    worker.resourceUsage = heartbeat.resourceUsage;
    worker.lastHeartbeat = heartbeat.timestamp;

    // 重置心跳超时
    this.resetHeartbeatTimeout(heartbeat.workerId);
  }

  /**
   * 选择最合适的 Worker
   */
  async selectWorker(subtask: Subtask, enableLoadBalancing: boolean): Promise<WorkerInfo | null> {
    const availableWorkers = Array.from(this.workers.values()).filter(
      w => w.status === 'idle' && w.lastHeartbeat > Date.now() - this.config.workerTimeout
    );

    if (availableWorkers.length === 0) {
      return null;
    }

    if (!enableLoadBalancing) {
      return availableWorkers[0];
    }

    // 负载均衡：选择资源使用率最低的 Worker
    return availableWorkers.reduce((best, worker) => {
      const bestScore = this.calculateWorkerScore(best);
      const workerScore = this.calculateWorkerScore(worker);
      return workerScore > bestScore ? worker : best;
    });
  }

  /**
   * 计算 Worker 分数（越高越好）
   */
  private calculateWorkerScore(worker: WorkerInfo): number {
    const { cpu, memory, disk } = worker.resourceUsage;
    
    // 分数 = 100 - 平均资源使用率
    const avgUsage = (cpu + memory + disk) / 3;
    return 100 - avgUsage;
  }

  /**
   * 分配任务给 Worker
   */
  async assignTask(workerId: string, subtask: Subtask): Promise<void> {
    const worker = this.workers.get(workerId);
    
    if (!worker) {
      throw new Error(`Worker 不存在：${workerId}`);
    }

    // 发送任务分配命令
    const command: WorkerCommand = {
      type: 'ASSIGN_TASK',
      taskId: subtask.id,
      payload: {
        subtask,
      },
    };

    await this.sendCommand(workerId, command);
    
    // 更新 Worker 状态
    worker.status = 'busy';
    worker.currentTaskId = subtask.id;

    // 记录待处理任务
    this.pendingTasks.set(subtask.id, subtask);

    console.log(`[WorkerManager] 任务分配：${subtask.id} → ${workerId}`);
  }

  /**
   * 发送命令给 Worker
   */
  private async sendCommand(workerId: string, command: WorkerCommand): Promise<void> {
    // TODO: 实际实现时通过 HTTP/gRPC/WebSocket 发送
    console.log(`[WorkerManager] 发送命令给 ${workerId}:`, command.type);
    
    // 示例：HTTP 请求
    // const worker = this.workers.get(workerId);
    // if (worker) {
    //   await fetch(`http://${workerId}/command`, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(command),
    //   });
    // }
  }

  /**
   * 处理 Worker 响应
   */
  async handleWorkerResponse(response: WorkerResponse): Promise<void> {
    console.log(`[WorkerManager] 收到 Worker 响应：${response.type} - ${response.taskId}`);

    switch (response.type) {
      case 'TASK_ACCEPTED':
        await this.handleTaskAccepted(response);
        break;
      case 'TASK_PROGRESS':
        await this.handleTaskProgress(response);
        break;
      case 'TASK_COMPLETED':
        await this.handleTaskCompleted(response);
        break;
      case 'TASK_FAILED':
        await this.handleTaskFailed(response);
        break;
    }
  }

  private async handleTaskAccepted(response: WorkerResponse): Promise<void> {
    const worker = this.workers.get(response.workerId);
    if (worker) {
      worker.status = 'busy';
    }
  }

  private async handleTaskProgress(response: WorkerResponse): Promise<void> {
    // 进度汇报由 Orchestrator 处理
  }

  private async handleTaskCompleted(response: WorkerResponse): Promise<void> {
    const worker = this.workers.get(response.workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
    }
    
    this.pendingTasks.delete(response.taskId);
  }

  private async handleTaskFailed(response: WorkerResponse): Promise<void> {
    const worker = this.workers.get(response.workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
    }
    
    this.pendingTasks.delete(response.taskId);
  }

  /**
   * 重置心跳超时
   */
  private resetHeartbeatTimeout(workerId: string): void {
    const existing = this.heartbeatTimeouts.get(workerId);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      this.handleWorkerTimeout(workerId);
    }, this.config.workerTimeout);

    this.heartbeatTimeouts.set(workerId, timeout);
  }

  /**
   * 处理 Worker 超时
   */
  private handleWorkerTimeout(workerId: string): void {
    const worker = this.workers.get(workerId);
    
    if (worker) {
      console.warn(`[WorkerManager] Worker 超时：${workerId}`);
      worker.status = 'offline';
      
      // 重新分配任务
      if (worker.currentTaskId) {
        this.pendingTasks.get(worker.currentTaskId);
        // TODO: 重新分配任务
      }
    }
  }

  /**
   * 获取空闲 Worker 数量
   */
  getIdleWorkerCount(): number {
    return Array.from(this.workers.values()).filter(
      w => w.status === 'idle' && w.lastHeartbeat > Date.now() - this.config.workerTimeout
    ).length;
  }

  /**
   * 获取所有 Worker
   */
  getAllWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  /**
   * 关闭 Worker 管理器
   */
  async shutdown(): Promise<void> {
    console.log('[WorkerManager] 正在关闭...');
    
    // 发送关闭命令给所有 Worker
    for (const workerId of this.workers.keys()) {
      try {
        await this.sendCommand(workerId, {
          type: 'SHUTDOWN',
          taskId: '',
        });
      } catch (error) {
        console.error(`[WorkerManager] 关闭 Worker 失败 ${workerId}:`, error);
      }
    }

    // 清理所有超时
    for (const timeout of this.heartbeatTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.heartbeatTimeouts.clear();

    this.workers.clear();
    this.pendingTasks.clear();

    console.log('[WorkerManager] 已关闭');
  }
}
