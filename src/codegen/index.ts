/**
 * 代码生成模块入口文件
 */

// 类型定义
export type {
  UserRequest,
  AgentRole,
  AgentMessage,
  ProductSpec,
  ArchitectureDesign,
  CodeGenResult,
  ReviewReport,
  DeploymentResult,
  GenerationTask,
  AgentConfig,
} from './types.js';

// 基础类
export { BaseAgent, createAgentMessage } from './base-agent.js';
export type { AgentContext, LLMClient } from './base-agent.js';

// 智能体
export { PMAgent, createPMAgent } from './agents/pm-agent.js';

// 调度器
export { Orchestrator, createOrchestrator } from './orchestrator.js';

// LLM 客户端
export {
  UniversalLLMClient,
  createLLMClientFromEnv,
  createAnthropicClientFromEnv, // 保持向后兼容
} from './llm-client.js';
export type { UniversalLLMConfig, LLMProvider } from './llm-client.js';
