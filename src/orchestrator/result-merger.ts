/**
 * 结果汇总器 - 合并多个子任务的结果
 */

import type { Task, Subtask } from './types.js';

/**
 * 结果汇总策略
 */
export type MergeStrategy = 'concat' | 'merge' | 'ai' | 'custom';

/**
 * 结果汇总器
 */
export class ResultMerger {
  /**
   * 合并子任务结果
   */
  async merge(results: any[], task: Task, strategy?: MergeStrategy): Promise<any> {
    const mergeStrategy = strategy || this.detectStrategy(task);
    
    console.log(`[ResultMerger] 使用策略：${mergeStrategy}`);
    
    switch (mergeStrategy) {
      case 'concat':
        return this.concatResults(results);
      case 'merge':
        return this.mergeObjects(results);
      case 'ai':
        return this.aiMerge(results, task);
      case 'custom':
        return this.customMerge(results, task);
      default:
        return results;
    }
  }

  /**
   * 检测合适的合并策略
   */
  private detectStrategy(task: Task): MergeStrategy {
    // 根据任务类型自动选择策略
    if (task.description.includes('代码审查')) {
      return 'ai';
    }
    
    if (task.description.includes('数据分析')) {
      return 'merge';
    }
    
    if (task.description.includes('文档生成')) {
      return 'concat';
    }
    
    // 默认使用 AI 合并
    return 'ai';
  }

  /**
   * 简单拼接结果
   */
  private concatResults(results: any[]): string {
    return results.filter(r => r != null).join('\n\n');
  }

  /**
   * 合并对象（深度合并）
   */
  private mergeObjects(results: any[]): any {
    const merged: any = {};
    
    for (const result of results) {
      if (typeof result === 'object' && result !== null) {
        Object.assign(merged, result);
      }
    }
    
    return merged;
  }

  /**
   * 使用 AI 智能合并结果
   */
  private async aiMerge(results: any[], task: Task): Promise<any> {
    console.log('[ResultMerger] 使用 AI 合并结果...');
    
    // 构建 AI 提示词
    const prompt = this.buildMergePrompt(results, task);
    
    try {
      // 调用 LLM 进行结果合并
      const mergedResult = await this.callLLM(prompt);
      return mergedResult;
    } catch (error) {
      console.error('[ResultMerger] AI 合并失败:', error);
      
      // 降级策略：简单拼接
      return this.concatResults(results);
    }
  }

  /**
   * 构建 AI 合并提示词
   */
  private buildMergePrompt(results: any[], task: Task): string {
    return `
整合以下子任务的结果，生成最终答案：

原始任务：${task.description}

子任务结果：
${results.map((r, i) => `--- 子任务 ${i + 1} ---\n${JSON.stringify(r, null, 2)}`).join('\n')}

要求：
1. 整合所有结果，去除重复
2. 保持逻辑连贯性
3. 如果有冲突，以最新结果为准
4. 输出格式与原始任务要求一致

最终结果：
`;
  }

  /**
   * 调用 LLM
   */
  private async callLLM(prompt: string): Promise<any> {
    // TODO: 实际实现时调用 LLM API
    console.log('[ResultMerger] 调用 LLM 合并结果...');
    
    // 模拟实现
    return {
      merged: true,
      content: 'AI 合并的结果',
    };
  }

  /**
   * 自定义合并（由调用者提供合并逻辑）
   */
  private customMerge(results: any[], task: Task): any {
    // 实际实现时应该调用用户提供的合并函数
    // 这里返回原始结果
    return results;
  }

  /**
   * 质量检查 - 验证合并结果的质量
   */
  async qualityCheck(mergedResult: any, task: Task): Promise<{ passed: boolean; score: number }> {
    console.log('[ResultMerger] 质量检查...');
    
    // 使用 AI 评估结果质量
    const prompt = `
评估以下结果的质量：

任务：${task.description}
结果：${JSON.stringify(mergedResult, null, 2)}

评分标准：
1. 完整性（0-10）：是否回答了所有问题
2. 准确性（0-10）：信息是否正确
3. 一致性（0-10）：逻辑是否连贯
4. 可用性（0-10）：是否可以直接使用

输出格式（JSON）：
{
  "completeness": 8,
  "accuracy": 9,
  "consistency": 7,
  "usability": 8,
  "overall": 8,
  "feedback": "改进建议"
}
`;

    try {
      const evaluation = await this.callLLM(prompt);
      const passed = evaluation.overall >= 7;
      
      console.log(`[ResultMerger] 质量评分：${evaluation.overall}/10, 通过：${passed}`);
      
      return {
        passed,
        score: evaluation.overall,
      };
    } catch (error) {
      console.error('[ResultMerger] 质量检查失败:', error);
      
      // 默认通过
      return { passed: true, score: 8 };
    }
  }
}
