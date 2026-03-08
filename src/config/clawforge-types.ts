/**
 * ClawForge 多租户配置类型定义
 * 
 * 支持运行时环境变量注入：
 * - ORG_ID: 组织 ID
 * - USER_ID: 用户 ID
 * - WORKSPACE: 动态工作目录
 * - API_KEYS: API 密钥动态注入
 */

/**
 * 运行时配置（动态注入）
 */
export interface ClawForgeRuntimeConfig {
  /** 组织 ID */
  orgId: string;
  
  /** 用户 ID */
  userId: string;
  
  /** 动态工作目录路径 */
  workspace: string;
  
  /** 记忆存储配置 */
  memoryStore?: {
    provider: 'qdrant' | 'local';
    host?: string;
    port?: number;
    apiKey?: string;
    tenantId: string;  // 用于多租户隔离
  };
  
  /** API 密钥（动态注入） */
  apiKeys: {
    embedding?: string;
    llm?: string;
    reranker?: string;
  };
}

/**
 * 基础配置（固定）
 */
export interface ClawForgeBaseConfig {
  /** Gateway 配置 */
  gateway: {
    port: number;
    token: string;
    host?: string;
  };
  
  /** 模型配置 */
  models: {
    embedding: {
      provider: string;
      model: string;
      dimensions: number;
    };
    llm: {
      provider: string;
      model: string;
    };
    reranker?: {
      provider: string;
      model: string;
    };
  };
  
  /** 技能系统配置 */
  skills: {
    enabled: boolean;
    directory?: string;
    permissionCheck: boolean;  // 启用权限验证
  };
  
  /** 容器化配置 */
  container: {
    enabled: boolean;
    mode?: 'standalone' | 'worker' | 'orchestrator';
  };
}

/**
 * 完整配置（基础 + 运行时）
 */
export interface ClawForgeConfig extends ClawForgeBaseConfig {
  /** 运行时配置（可选，启动时注入） */
  runtime?: ClawForgeRuntimeConfig;
}

/**
 * 主从架构配置
 */
export interface OrchestratorWorkerConfig {
  /** 运行模式 */
  mode: 'orchestrator' | 'worker' | 'standalone';
  
  /** Orchestrator 配置 */
  orchestrator?: {
    maxWorkers: number;
    taskTimeout: number;
    workerTimeout: number;
    retryAttempts: number;
    enableLoadBalancing: boolean;
    enableProgressTracking: boolean;
  };
  
  /** Worker 配置 */
  worker?: {
    orchestratorUrl: string;
    heartbeatInterval: number;
    maxConcurrentTasks: number;
    resourceLimits: {
      maxMemory: string;
      maxCpu: string;
      maxDisk: string;
    };
  };
}

/**
 * 环境变量接口
 */
export interface ClawForgeEnvVars {
  // 租户标识
  ORG_ID: string;
  USER_ID: string;
  
  // 路径配置
  WORKSPACE: string;
  OPENCLAW_STATE_DIR?: string;
  
  // API 密钥
  EMBEDDING_API_KEY?: string;
  LLM_API_KEY?: string;
  RERANK_API_KEY?: string;
  QDRANT_API_KEY?: string;
  
  // Qdrant 配置
  QDRANT_HOST?: string;
  QDRANT_PORT?: string;
  
  // 运行模式
  OPENCLAW_MODE?: 'standalone' | 'orchestrator' | 'worker';
  
  // Orchestrator 配置
  ORCHESTRATOR_URL?: string;
  MAX_WORKERS?: string;
  
  // Worker 配置
  HEARTBEAT_INTERVAL?: string;
  MAX_CONCURRENT_TASKS?: string;
}
