/**
 * ClawForge Worker - 子节点实现
 * 
 * 负责执行主节点分配的子任务
 */

import type { Subtask, WorkerConfig, Heartbeat, WorkerCommand, WorkerResponse } from './types.js';

/**
 * Worker 实现
 */
export class Worker {
  private config: WorkerConfig;
  private workerId: string;
  private status: 'idle' | 'busy' | 'offline' = 'idle';
  private currentTask: Subtask | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private connected: boolean = false;

  constructor(config: WorkerConfig, workerId?: string) {
    this.config = config;
    this.workerId = workerId || this.generateWorkerId();
  }

  /**
   * 生成 Worker ID
   */
  private generateWorkerId(): string {
    return `worker_${Date.now()}_${process.pid}`;
  }

  /**
   * 启动 Worker
   */
  async start(): Promise<void> {
    console.log(`[Worker] 启动：${this.workerId}`);
    
    // 连接到 Orchestrator
    await this.connectToOrchestrator();
    
    // 启动心跳
    this.startHeartbeat();
    
    console.log(`[Worker] 已启动，等待任务...`);
  }

  /**
   * 连接到 Orchestrator
   */
  private async connectToOrchestrator(): Promise<void> {
    try {
      // TODO: 实际实现时建立 WebSocket/gRPC 连接
      console.log(`[Worker] 连接到 Orchestrator: ${this.config.orchestratorUrl}`);
      
      this.connected = true;
      
      // 发送注册消息
      await this.sendRegistration();
    } catch (error) {
      console.error('[Worker] 连接失败:', error);
      this.status = 'offline';
      throw error;
    }
  }

  /**
   * 发送注册消息
   */
  private async sendRegistration(): Promise<void> {
    // TODO: 实现注册逻辑
    console.log(`[Worker] 注册到 Orchestrator`);
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }

  /**
   * 发送心跳
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.connected) {
      return;
    }

    const heartbeat: Heartbeat = {
      workerId: this.workerId,
      status: this.status,
      currentTaskId: this.currentTask?.id,
      resourceUsage: await this.getResourceUsage(),
      timestamp: Date.now(),
    };

    // TODO: 发送心跳到 Orchestrator
    // await fetch(`${this.config.orchestratorUrl}/heartbeat`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(heartbeat),
    // });
    
    console.log(`[Worker] 心跳：${this.status}`);
  }

  /**
   * 获取资源使用情况
   */
  private async getResourceUsage(): Promise<{ cpu: number; memory: number; disk: number }> {
    // TODO: 实际获取系统资源使用情况
    return {
      cpu: Math.random() * 30,  // 模拟
      memory: Math.random() * 50,
      disk: Math.random() * 20,
    };
  }

  /**
   * 处理来自 Orchestrator 的命令
   */
  async handleCommand(command: WorkerCommand): Promise<void> {
    console.log(`[Worker] 收到命令：${command.type}`);

    switch (command.type) {
      case 'ASSIGN_TASK':
        await this.handleAssignTask(command);
        break;
      case 'CANCEL_TASK':
        await this.handleCancelTask(command);
        break;
      case 'GET_STATUS':
        await this.handleGetStatus(command);
        break;
      case 'SHUTDOWN':
        await this.handleShutdown(command);
        break;
    }
  }

  /**
   * 处理任务分配
   */
  private async handleAssignTask(command: WorkerCommand): Promise<void> {
    const subtask: Subtask = command.payload.subtask;
    
    console.log(`[Worker] 接收子任务：${subtask.id} - ${subtask.description}`);
    
    this.currentTask = subtask;
    this.status = 'busy';

    // 确认接收
    await this.sendResponse({
      type: 'TASK_ACCEPTED',
      taskId: subtask.id,
      workerId: this.workerId,
      timestamp: Date.now(),
    });

    // 执行任务
    try {
      await this.executeTask(subtask);
    } catch (error) {
      console.error('[Worker] 任务执行失败:', error);
      
      await this.sendResponse({
        type: 'TASK_FAILED',
        taskId: subtask.id,
        workerId: this.workerId,
        error: error.message,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 执行子任务
   */
  private async executeTask(subtask: Subtask): Promise<void> {
    console.log(`[Worker] 执行任务：${subtask.id}`);
    
    // TODO: 实际实现时调用 OpenClaw 的工具/技能执行任务
    // 这里使用模拟实现
    
    const startTime = Date.now();
    let progress = 0;

    // 模拟任务执行
    while (progress < 100) {
      await new Promise(resolve => setTimeout(resolve, 500));
      progress += 10;
      
      // 汇报进度
      await this.sendResponse({
        type: 'TASK_PROGRESS',
        taskId: subtask.id,
        workerId: this.workerId,
        progress,
        timestamp: Date.now(),
      });
    }

    // 任务完成
    const result = {
      success: true,
      output: '任务执行结果',
      duration: Date.now() - startTime,
    };

    this.currentTask = null;
    this.status = 'idle';

    await this.sendResponse({
      type: 'TASK_COMPLETED',
      taskId: subtask.id,
      workerId: this.workerId,
      result,
      timestamp: Date.now(),
    });

    console.log(`[Worker] 任务完成：${subtask.id}`);
  }

  /**
   * 处理任务取消
   */
  private async handleCancelTask(command: WorkerCommand): Promise<void> {
    console.log(`[Worker] 取消任务：${command.taskId}`);
    
    if (this.currentTask?.id === command.taskId) {
      // 停止当前任务
      this.currentTask = null;
      this.status = 'idle';
    }
  }

  /**
   * 处理状态查询
   */
  private async handleGetStatus(command: WorkerCommand): Promise<void> {
    await this.sendHeartbeat();
  }

  /**
   * 处理关闭命令
   */
  private async handleShutdown(command: WorkerCommand): Promise<void> {
    console.log('[Worker] 收到关闭命令');
    await this.shutdown();
  }

  /**
   * 发送响应给 Orchestrator
   */
  private async sendResponse(response: WorkerResponse): Promise<void> {
    // TODO: 实际实现时发送到 Orchestrator
    console.log(`[Worker] 发送响应：${response.type}`);
    
    // await fetch(`${this.config.orchestratorUrl}/response`, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify(response),
    // });
  }

  /**
   * 检查资源限制
   */
  private checkResourceLimits(): boolean {
    // TODO: 检查 CPU、内存、磁盘是否超出限制
    return true;
  }

  /**
   * 关闭 Worker
   */
  async shutdown(): Promise<void> {
    console.log('[Worker] 正在关闭...');
    
    // 停止心跳
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // 等待当前任务完成（如果有）
    if (this.currentTask) {
      console.log('[Worker] 等待当前任务完成...');
      // 可以选择等待或强制停止
    }

    this.connected = false;
    this.status = 'offline';

    console.log('[Worker] 已关闭');
  }

  /**
   * 获取 Worker 状态
   */
  getStatus(): {
    workerId: string;
    status: string;
    currentTaskId?: string;
    connected: boolean;
  } {
    return {
      workerId: this.workerId,
      status: this.status,
      currentTaskId: this.currentTask?.id,
      connected: this.connected,
    };
  }
}

/**
 * 创建 Worker 实例
 */
export function createWorker(config: WorkerConfig, workerId?: string): Worker {
  return new Worker(config, workerId);
}
