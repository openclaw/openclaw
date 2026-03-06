/**
 * Orchestrator - 智能体调度器
 * 负责协调多个智能体的工作流程
 */

import type {
  UserRequest,
  GenerationTask,
  AgentRole,
  AgentMessage,
} from './types.js';
import type { BaseAgent, AgentContext, LLMClient } from './base-agent.js';
import { createPMAgent } from './agents/pm-agent.js';

/**
 * 工作流阶段
 */
type WorkflowStage = 'pm' | 'architect' | 'coding' | 'review' | 'test' | 'deploy';

/**
 * 工作流配置
 */
interface WorkflowConfig {
  /** 是否启用某个阶段 */
  stages: {
    pm: boolean;
    architect: boolean;
    coding: boolean;
    review: boolean;
    test: boolean;
    deploy: boolean;
  };
  /** 并行编码的智能体数量 */
  parallel_coders?: number;
  /** 是否自动重试失败的阶段 */
  auto_retry?: boolean;
  /** 最大重试次数 */
  max_retries?: number;
}

/**
 * Orchestrator 类
 */
export class Orchestrator {
  private agents: Map<AgentRole, BaseAgent>;
  private tasks: Map<string, GenerationTask>;
  private llmClient: LLMClient;
  private workflowConfig: WorkflowConfig;

  constructor(llmClient: LLMClient, config?: Partial<WorkflowConfig>) {
    this.llmClient = llmClient;
    this.agents = new Map();
    this.tasks = new Map();

    // 默认工作流配置
    this.workflowConfig = {
      stages: {
        pm: true,
        architect: true,
        coding: true,
        review: true,
        test: false,      // MVP 阶段暂不启用
        deploy: false,    // MVP 阶段暂不启用
      },
      parallel_coders: 1,
      auto_retry: true,
      max_retries: 3,
      ...config,
    };

    // 初始化智能体
    this.initializeAgents();
  }

  /**
   * 初始化智能体
   */
  private initializeAgents(): void {
    // 注册 PM Agent
    this.agents.set('pm', createPMAgent());

    // TODO: 注册其他智能体
    // this.agents.set('architect', createArchitectAgent());
    // this.agents.set('coder', createCoderAgent());
    // this.agents.set('reviewer', createReviewerAgent());
  }

  /**
   * 创建新任务
   */
  createTask(request: UserRequest): GenerationTask {
    const task: GenerationTask = {
      task_id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      request,
      status: 'pending',
      current_stage: 'pm',
      outputs: {},
      created_at: Date.now(),
    };

    this.tasks.set(task.task_id, task);
    this.log('info', 'Task created', { task_id: task.task_id });

    return task;
  }

  /**
   * 执行任务
   */
  async executeTask(taskId: string): Promise<GenerationTask> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.log('info', 'Starting task execution', { task_id: taskId });
    task.status = 'in_progress';

    try {
      // 执行工作流
      await this.runWorkflow(task);

      task.status = 'completed';
      task.completed_at = Date.now();
      this.log('info', 'Task completed', {
        task_id: taskId,
        duration_ms: task.completed_at - task.created_at,
      });
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      this.log('error', 'Task failed', {
        task_id: taskId,
        error: task.error,
      });
      throw error;
    }

    return task;
  }

  /**
   * 运行工作流
   */
  private async runWorkflow(task: GenerationTask): Promise<void> {
    const stages: WorkflowStage[] = [];

    // 根据配置构建工作流
    if (this.workflowConfig.stages.pm) stages.push('pm');
    if (this.workflowConfig.stages.architect) stages.push('architect');
    if (this.workflowConfig.stages.coding) stages.push('coding');
    if (this.workflowConfig.stages.review) stages.push('review');
    if (this.workflowConfig.stages.test) stages.push('test');
    if (this.workflowConfig.stages.deploy) stages.push('deploy');

    // 顺序执行各个阶段
    for (const stage of stages) {
      task.current_stage = stage;
      this.log('info', `Executing stage: ${stage}`, { task_id: task.task_id });

      await this.executeStage(task, stage);
    }
  }

  /**
   * 执行单个阶段
   */
  private async executeStage(
    task: GenerationTask,
    stage: WorkflowStage
  ): Promise<void> {
    const context: AgentContext = {
      request_id: task.request.request_id,
      task_id: task.task_id,
      context: task.outputs,
      llm: this.llmClient,
    };

    let retries = 0;
    const maxRetries = this.workflowConfig.max_retries || 3;

    while (retries <= maxRetries) {
      try {
        switch (stage) {
          case 'pm':
            await this.executePMStage(task, context);
            break;
          case 'architect':
            await this.executeArchitectStage(task, context);
            break;
          case 'coding':
            await this.executeCodingStage(task, context);
            break;
          case 'review':
            await this.executeReviewStage(task, context);
            break;
          case 'test':
            await this.executeTestStage(task, context);
            break;
          case 'deploy':
            await this.executeDeployStage(task, context);
            break;
          default:
            throw new Error(`Unknown stage: ${stage}`);
        }

        // 成功执行，退出重试循环
        break;
      } catch (error) {
        retries++;
        this.log('warn', `Stage ${stage} failed, retry ${retries}/${maxRetries}`, {
          task_id: task.task_id,
          error: error instanceof Error ? error.message : String(error),
        });

        if (retries > maxRetries) {
          throw new Error(
            `Stage ${stage} failed after ${maxRetries} retries: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        // 等待一段时间后重试
        await this.sleep(1000 * retries);
      }
    }
  }

  /**
   * 执行 PM 阶段
   */
  private async executePMStage(
    task: GenerationTask,
    context: AgentContext
  ): Promise<void> {
    const pmAgent = this.agents.get('pm');
    if (!pmAgent) {
      throw new Error('PM Agent not found');
    }

    const productSpec = await pmAgent.execute(task.request, context);
    task.outputs.product_spec = productSpec;
  }

  /**
   * 执行 Architect 阶段
   */
  private async executeArchitectStage(
    task: GenerationTask,
    context: AgentContext
  ): Promise<void> {
    // TODO: 实现架构师阶段
    this.log('warn', 'Architect stage not implemented yet');
    throw new Error('Architect stage not implemented');
  }

  /**
   * 执行 Coding 阶段
   */
  private async executeCodingStage(
    task: GenerationTask,
    context: AgentContext
  ): Promise<void> {
    // TODO: 实现编码阶段
    this.log('warn', 'Coding stage not implemented yet');
    throw new Error('Coding stage not implemented');
  }

  /**
   * 执行 Review 阶段
   */
  private async executeReviewStage(
    task: GenerationTask,
    context: AgentContext
  ): Promise<void> {
    // TODO: 实现审查阶段
    this.log('warn', 'Review stage not implemented yet');
    throw new Error('Review stage not implemented');
  }

  /**
   * 执行 Test 阶段
   */
  private async executeTestStage(
    task: GenerationTask,
    context: AgentContext
  ): Promise<void> {
    // TODO: 实现测试阶段
    this.log('warn', 'Test stage not implemented yet');
    throw new Error('Test stage not implemented');
  }

  /**
   * 执行 Deploy 阶段
   */
  private async executeDeployStage(
    task: GenerationTask,
    context: AgentContext
  ): Promise<void> {
    // TODO: 实现部署阶段
    this.log('warn', 'Deploy stage not implemented yet');
    throw new Error('Deploy stage not implemented');
  }

  /**
   * 获取任务状态
   */
  getTask(taskId: string): GenerationTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): GenerationTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 注册自定义智能体
   */
  registerAgent(role: AgentRole, agent: BaseAgent): void {
    this.agents.set(role, agent);
    this.log('info', `Agent registered: ${role}`);
  }

  /**
   * 更新工作流配置
   */
  updateWorkflowConfig(config: Partial<WorkflowConfig>): void {
    this.workflowConfig = {
      ...this.workflowConfig,
      ...config,
      stages: {
        ...this.workflowConfig.stages,
        ...config.stages,
      },
    };
    this.log('info', 'Workflow config updated', this.workflowConfig);
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 日志记录
   */
  private log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      component: 'Orchestrator',
      level,
      message,
      data,
    };
    console.log(JSON.stringify(logEntry));
  }
}

/**
 * 创建 Orchestrator 实例
 */
export function createOrchestrator(
  llmClient: LLMClient,
  config?: Partial<WorkflowConfig>
): Orchestrator {
  return new Orchestrator(llmClient, config);
}
