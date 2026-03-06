/**
 * 代码生成系统的核心类型定义
 */

// ============================================================================
// 用户请求类型
// ============================================================================

export interface UserRequest {
  /** 用户自然语言描述 */
  description: string;
  /** 应用类型 */
  type: 'web' | 'api' | 'mobile' | 'desktop' | 'cli';
  /** 约束条件 */
  constraints?: {
    budget?: number;
    timeline?: string;
    tech_stack?: string[];
    performance?: string;
    security?: string;
  };
  /** 用户ID（用于确权） */
  user_id: string;
  /** 请求ID */
  request_id: string;
}

// ============================================================================
// 智能体角色类型
// ============================================================================

export type AgentRole =
  | 'pm'           // 产品经理
  | 'architect'    // 架构师
  | 'coder'        // 编码者
  | 'reviewer'     // 审查者
  | 'devops'       // DevOps
  | 'database'     // 数据库
  | 'security'     // 安全
  | 'test';        // 测试

// ============================================================================
// 智能体消息类型
// ============================================================================

export interface AgentMessage {
  /** 消息ID */
  id: string;
  /** 发送者角色 */
  from: AgentRole;
  /** 接收者角色 */
  to: AgentRole | 'orchestrator';
  /** 消息类型 */
  type: 'task' | 'result' | 'error' | 'query';
  /** 消息内容 */
  payload: any;
  /** 时间戳 */
  timestamp: number;
  /** 关联的请求ID */
  request_id: string;
}

// ============================================================================
// 产品规格（PM Agent 输出）
// ============================================================================

export interface ProductSpec {
  /** 用户故事 */
  user_stories: Array<{
    as: string;              // 作为...
    i_want: string;          // 我想要...
    so_that: string;         // 以便...
    acceptance_criteria: string[];
  }>;
  /** 功能清单 */
  features: Array<{
    name: string;
    priority: 'high' | 'medium' | 'low';
    description: string;
  }>;
  /** 非功能性需求 */
  non_functional_requirements: {
    performance?: string;
    security?: string;
    scalability?: string;
  };
}

// ============================================================================
// 架构设计（Architect Agent 输出）
// ============================================================================

export interface ArchitectureDesign {
  /** 技术栈 */
  tech_stack: {
    frontend: string[];
    backend: string[];
    database: string[];
    infrastructure: string[];
  };
  /** 数据模型 */
  data_model: {
    entities: Array<{
      name: string;
      fields: Array<{
        name: string;
        type: string;
        required: boolean;
        default?: any;
      }>;
      relationships: Array<{
        type: 'one-to-many' | 'many-to-many' | 'one-to-one';
        target: string;
        field?: string;
      }>;
    }>;
  };
  /** API 设计 */
  api_design: {
    endpoints: Array<{
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
      path: string;
      description: string;
      request?: any;
      response?: any;
    }>;
  };
  /** 架构图（Mermaid 格式） */
  architecture_diagram?: string;
}

// ============================================================================
// 代码生成结果（Coder Agent 输出）
// ============================================================================

export interface CodeGenResult {
  /** 生成的文件 */
  files: Array<{
    path: string;
    content: string;
    language: string;
  }>;
  /** 依赖项 */
  dependencies: {
    [packageName: string]: string; // version
  };
  /** 构建配置 */
  build_config?: {
    scripts: Record<string, string>;
    env_vars?: Record<string, string>;
  };
  /** 生成元数据 */
  metadata: {
    generated_at: number;
    model_used: string;
    tokens_used: number;
  };
}

// ============================================================================
// 代码审查报告（Reviewer Agent 输出）
// ============================================================================

export interface ReviewReport {
  /** 总体评分 (0-100) */
  overall_score: number;
  /** 问题列表 */
  issues: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    type: 'syntax' | 'security' | 'performance' | 'style' | 'logic';
    file: string;
    line?: number;
    message: string;
    suggestion?: string;
  }>;
  /** 是否通过审查 */
  approval: boolean;
  /** 总体反馈 */
  feedback: string;
  /** 详细指标 */
  metrics: {
    complexity_score: number;
    security_score: number;
    performance_score: number;
    maintainability_score: number;
  };
}

// ============================================================================
// 部署结果（DevOps Agent 输出）
// ============================================================================

export interface DeploymentResult {
  /** 部署状态 */
  status: 'success' | 'failed' | 'pending';
  /** 部署的 URL */
  urls: {
    frontend?: string;
    backend?: string;
    admin?: string;
  };
  /** 部署平台 */
  platform: 'vercel' | 'railway' | 'aws' | 'gcp' | 'azure';
  /** 部署配置 */
  config: {
    region?: string;
    instance_type?: string;
    auto_scaling?: boolean;
  };
  /** 错误信息（如果失败） */
  error?: string;
}

// ============================================================================
// 完整的生成任务
// ============================================================================

export interface GenerationTask {
  /** 任务ID */
  task_id: string;
  /** 用户请求 */
  request: UserRequest;
  /** 当前状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** 当前阶段 */
  current_stage: 'pm' | 'architect' | 'coding' | 'review' | 'test' | 'deploy';
  /** 各阶段的输出 */
  outputs: {
    product_spec?: ProductSpec;
    architecture?: ArchitectureDesign;
    code?: CodeGenResult;
    review?: ReviewReport;
    deployment?: DeploymentResult;
  };
  /** 错误信息 */
  error?: string;
  /** 创建时间 */
  created_at: number;
  /** 完成时间 */
  completed_at?: number;
}

// ============================================================================
// 智能体配置
// ============================================================================

export interface AgentConfig {
  /** 角色 */
  role: AgentRole;
  /** 使用的模型 */
  model: string;
  /** 温度参数 */
  temperature: number;
  /** 最大 tokens */
  max_tokens: number;
  /** 系统提示词 */
  system_prompt: string;
  /** 工具列表 */
  tools?: string[];
}
