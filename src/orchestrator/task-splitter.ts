/**
 * 任务拆分器 - 使用 AI 智能拆分复杂任务
 */

import type { Task, Subtask } from './types.js';

/**
 * 任务拆分器
 */
export class TaskSplitter {
  /**
   * 使用 AI 分析并拆分任务
   */
  async splitTask(task: Task): Promise<Subtask[]> {
    console.log(`[TaskSplitter] 分析任务：${task.description}`);

    // 构建 AI 提示词
    const prompt = this.buildSplitPrompt(task);
    
    try {
      // 调用 LLM 进行任务分析
      const analysis = await this.callLLM(prompt);
      
      // 解析结果并生成子任务
      const subtasks = this.parseSubtasks(analysis, task);
      
      console.log(`[TaskSplitter] 任务拆分为 ${subtasks.length} 个子任务`);
      
      return subtasks;
    } catch (error) {
      console.error('[TaskSplitter] 任务拆分失败:', error);
      
      // 降级策略：不拆分，直接返回单个子任务
      return [this.createFallbackSubtask(task)];
    }
  }

  /**
   * 构建任务拆分的提示词
   */
  private buildSplitPrompt(task: Task): string {
    return `
分析以下任务，识别可并行的子任务：

任务：${task.description}
输入：${JSON.stringify(task.input, null, 2)}

要求：
1. 识别任务中的独立部分
2. 分析子任务之间的依赖关系
3. 生成可并行执行的子任务列表
4. 每个子任务应该是原子化的（不可再分）
5. 为每个子任务估算权重（1-10，表示复杂度）

输出格式（JSON）：
{
  "subtasks": [
    {
      "description": "子任务描述",
      "input": {},
      "dependencies": [],
      "weight": 5,
      "estimatedDuration": 300
    }
  ]
}

注意：
- 如果任务本身很简单，不需要拆分，返回单个子任务
- 确保子任务之间没有循环依赖
- 尽量平衡各子任务的工作量
`;
  }

  /**
   * 调用 LLM
   */
  private async callLLM(prompt: string): Promise<any> {
    // TODO: 实际实现时调用 LLM API
    // 这里使用模拟实现
    
    console.log('[TaskSplitter] 调用 LLM 分析任务...');
    
    // 模拟 LLM 响应（开发测试用）
    // 实际应该调用：
    // const response = await fetch(llmEndpoint, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ prompt })
    // });
    // return await response.json();
    
    // 示例响应
    return {
      subtasks: [
        {
          description: '示例子任务 1',
          input: {},
          dependencies: [],
          weight: 5,
          estimatedDuration: 300,
        },
      ],
    };
  }

  /**
   * 解析 LLM 响应并生成子任务
   */
  private parseSubtasks(analysis: any, parentTask: Task): Subtask[] {
    if (!analysis.subtasks || !Array.isArray(analysis.subtasks)) {
      throw new Error('LLM 返回格式错误');
    }

    return analysis.subtasks.map((subtask: any, index: number) => ({
      id: `${parentTask.id}_sub_${index}`,
      parentId: parentTask.id,
      description: subtask.description || `子任务 ${index}`,
      input: subtask.input || parentTask.input,
      dependencies: subtask.dependencies || [],
      weight: subtask.weight || 1,
      estimatedDuration: subtask.estimatedDuration || 60,
      status: 'pending',
      progress: 0,
      retryCount: 0,
    }));
  }

  /**
   * 降级策略：创建单个子任务
   */
  private createFallbackSubtask(task: Task): Subtask {
    return {
      id: `${task.id}_sub_0`,
      parentId: task.id,
      description: task.description,
      input: task.input,
      status: 'pending',
      progress: 0,
      retryCount: 0,
      weight: 1,
      estimatedDuration: 300,
    };
  }

  /**
   * 验证子任务依赖关系
   */
  validateDependencies(subtasks: Subtask[]): boolean {
    const ids = new Set(subtasks.map(st => st.id));
    
    for (const subtask of subtasks) {
      if (subtask.dependencies) {
        for (const depId of subtask.dependencies) {
          if (!ids.has(depId)) {
            console.error(`[TaskSplitter] 子任务 ${subtask.id} 依赖不存在的任务：${depId}`);
            return false;
          }
        }
      }
    }
    
    // 检查循环依赖（简单实现）
    // 实际应该使用拓扑排序
    
    return true;
  }
}
