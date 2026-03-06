/**
 * PM Agent - 产品经理智能体
 * 负责将用户需求转化为结构化的产品文档
 */

import { BaseAgent, type AgentContext } from '../base-agent.js';
import type { UserRequest, ProductSpec, AgentConfig } from '../types.js';

/**
 * PM Agent 的系统提示词
 */
const PM_SYSTEM_PROMPT = `你是一位资深的产品经理，擅长将用户的模糊需求转化为清晰的产品规格文档。

你的职责：
1. 分析用户需求，提取核心功能点
2. 编写用户故事（User Stories），使用标准格式："作为...，我想要...，以便..."
3. 列出功能清单，并按优先级排序（high/medium/low）
4. 定义验收标准（Acceptance Criteria）
5. 识别非功能性需求（性能、安全、可扩展性等）

输出格式要求：
- 必须输出有效的 JSON 格式
- 至少包含 3 个用户故事
- 每个功能必须有明确的优先级
- 验收标准要具体、可测试

示例输出：
\`\`\`json
{
  "user_stories": [
    {
      "as": "普通用户",
      "i_want": "能够注册账号",
      "so_that": "可以保存我的个人数据",
      "acceptance_criteria": [
        "用户可以通过邮箱注册",
        "密码长度至少8位",
        "注册成功后自动登录"
      ]
    }
  ],
  "features": [
    {
      "name": "用户注册",
      "priority": "high",
      "description": "允许新用户创建账号"
    }
  ],
  "non_functional_requirements": {
    "performance": "注册响应时间 < 2秒",
    "security": "密码必须加密存储",
    "scalability": "支持 10000+ 并发用户"
  }
}
\`\`\`

重要提示：
- 保持专业和客观
- 关注用户价值，而不是技术实现
- 优先级要合理，不要所有功能都是 high
- 验收标准要可量化、可测试`;

/**
 * PM Agent 实现
 */
export class PMAgent extends BaseAgent {
  constructor(config?: Partial<AgentConfig>) {
    super({
      role: 'pm',
      model: config?.model || 'claude-3-5-sonnet-20241022',
      temperature: config?.temperature ?? 0.7,
      max_tokens: config?.max_tokens || 4000,
      system_prompt: config?.system_prompt || PM_SYSTEM_PROMPT,
      tools: config?.tools,
    });
  }

  /**
   * 执行产品分析任务
   */
  async execute(
    input: UserRequest,
    context: AgentContext
  ): Promise<ProductSpec> {
    this.log('info', 'Starting PM analysis', { request_id: context.request_id });

    // 验证输入
    this.validateInput(input, ['description', 'type']);

    // 构建用户消息
    const userMessage = this.buildUserMessage(input);

    // 构建消息历史
    const messages = this.buildMessages(userMessage);

    // 调用 LLM
    this.log('info', 'Calling LLM for product analysis');
    const response = await this.callLLM(messages, context);

    // 解析响应
    const productSpec = this.parseJSONResponse<ProductSpec>(response);

    // 验证输出
    this.validateOutput(productSpec);

    this.log('info', 'PM analysis completed', {
      user_stories_count: productSpec.user_stories.length,
      features_count: productSpec.features.length,
    });

    return productSpec;
  }

  /**
   * 构建用户消息
   */
  private buildUserMessage(request: UserRequest): string {
    let message = `请分析以下用户需求，并生成产品规格文档：

**需求描述**：
${request.description}

**应用类型**：${request.type}
`;

    // 添加约束条件
    if (request.constraints) {
      message += '\n**约束条件**：\n';
      if (request.constraints.budget) {
        message += `- 预算：$${request.constraints.budget}\n`;
      }
      if (request.constraints.timeline) {
        message += `- 时间线：${request.constraints.timeline}\n`;
      }
      if (request.constraints.tech_stack) {
        message += `- 技术栈：${request.constraints.tech_stack.join(', ')}\n`;
      }
      if (request.constraints.performance) {
        message += `- 性能要求：${request.constraints.performance}\n`;
      }
      if (request.constraints.security) {
        message += `- 安全要求：${request.constraints.security}\n`;
      }
    }

    message += `
请输出完整的产品规格文档（JSON 格式），包括：
1. 用户故事（至少3个）
2. 功能清单（按优先级排序）
3. 非功能性需求

确保输出是有效的 JSON 格式。`;

    return message;
  }

  /**
   * 验证输出
   */
  private validateOutput(spec: ProductSpec): void {
    // 检查用户故事
    if (!spec.user_stories || spec.user_stories.length === 0) {
      throw new Error('Product spec must contain at least one user story');
    }

    for (const story of spec.user_stories) {
      if (!story.as || !story.i_want || !story.so_that) {
        throw new Error('Invalid user story format');
      }
      if (!story.acceptance_criteria || story.acceptance_criteria.length === 0) {
        throw new Error('User story must have acceptance criteria');
      }
    }

    // 检查功能清单
    if (!spec.features || spec.features.length === 0) {
      throw new Error('Product spec must contain at least one feature');
    }

    for (const feature of spec.features) {
      if (!feature.name || !feature.priority || !feature.description) {
        throw new Error('Invalid feature format');
      }
      if (!['high', 'medium', 'low'].includes(feature.priority)) {
        throw new Error(`Invalid priority: ${feature.priority}`);
      }
    }

    // 检查非功能性需求
    if (!spec.non_functional_requirements) {
      this.log('warn', 'No non-functional requirements specified');
    }
  }
}

/**
 * 创建 PM Agent 实例
 */
export function createPMAgent(config?: Partial<AgentConfig>): PMAgent {
  return new PMAgent(config);
}
