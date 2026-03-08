/**
 * ClawForge 配置加载器
 * 
 * 支持从环境变量注入运行时配置
 */

import path from 'node:path';
import type { ClawForgeConfig, ClawForgeRuntimeConfig, ClawForgeEnvVars } from './clawforge-types.js';

/**
 * 从环境变量加载运行时配置
 */
export function loadRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ClawForgeRuntimeConfig | null {
  const envVars = env as Partial<ClawForgeEnvVars>;
  
  // 必需的租户标识
  const orgId = envVars.ORG_ID;
  const userId = envVars.USER_ID;
  const workspace = envVars.WORKSPACE;
  
  if (!orgId || !userId) {
    // 没有提供租户标识，返回 null 使用默认配置
    return null;
  }
  
  // 验证工作目录
  if (!workspace) {
    throw new Error(
      'ClawForge 配置错误：提供了 ORG_ID/USER_ID 但未提供 WORKSPACE 环境变量'
    );
  }
  
  // 构建运行时配置
  const runtimeConfig: ClawForgeRuntimeConfig = {
    orgId,
    userId,
    workspace,
    
    // Qdrant 记忆存储配置
    memoryStore: envVars.QDRANT_HOST ? {
      provider: 'qdrant',
      host: envVars.QDRANT_HOST,
      port: envVars.QDRANT_PORT ? parseInt(envVars.QDRANT_PORT, 10) : 6333,
      apiKey: envVars.QDRANT_API_KEY,
      tenantId: orgId,  // 使用组织 ID 作为租户 ID 实现隔离
    } : undefined,
    
    // API 密钥
    apiKeys: {
      embedding: envVars.EMBEDDING_API_KEY,
      llm: envVars.LLM_API_KEY,
      reranker: envVars.RERANK_API_KEY,
    },
  };
  
  return runtimeConfig;
}

/**
 * 验证工作目录路径
 * 
 * 确保路径安全，防止越权访问
 */
export function validateWorkspacePath(workspace: string, orgId: string, userId: string): boolean {
  // 检查路径是否包含组织 ID 和用户 ID
  const expectedPattern = new RegExp(`/${orgId}.*${userId}`);
  if (!expectedPattern.test(workspace)) {
    console.warn(
      `警告：工作目录路径可能不安全：${workspace} (期望包含 ${orgId} 和 ${userId})`
    );
    return false;
  }
  
  // 检查是否尝试访问父目录
  if (workspace.includes('..')) {
    console.error(`错误：工作目录路径包含非法字符：${workspace}`);
    return false;
  }
  
  return true;
}

/**
 * 构建动态工作目录路径
 * 
 * 格式：/storage/{orgId}/{userId}/workspace
 */
export function buildWorkspacePath(
  baseStorage: string,
  orgId: string,
  userId: string
): string {
  // 清理 ID 中的非法字符
  const safeOrgId = orgId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  return path.join(baseStorage, safeOrgId, safeUserId, 'workspace');
}

/**
 * 合并基础配置和运行时配置
 */
export function mergeConfig(
  baseConfig: Partial<ClawForgeConfig>,
  runtimeConfig?: ClawForgeRuntimeConfig
): ClawForgeConfig {
  const config: ClawForgeConfig = {
    // 基础配置（带默认值）
    gateway: {
      port: baseConfig.gateway?.port || 3000,
      token: baseConfig.gateway?.token || '',
      host: baseConfig.gateway?.host || '0.0.0.0',
    },
    
    models: {
      embedding: baseConfig.models?.embedding || {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
      llm: baseConfig.models?.llm || {
        provider: 'openai',
        model: 'gpt-4o',
      },
      reranker: baseConfig.models?.reranker,
    },
    
    skills: {
      enabled: baseConfig.skills?.enabled ?? true,
      directory: baseConfig.skills?.directory,
      permissionCheck: baseConfig.skills?.permissionCheck ?? true,
    },
    
    container: {
      enabled: baseConfig.container?.enabled ?? false,
      mode: baseConfig.container?.mode || 'standalone',
    },
    
    // 运行时配置（如果提供）
    ...(runtimeConfig ? { runtime: runtimeConfig } : {}),
  };
  
  return config;
}

/**
 * 从环境变量加载完整配置
 */
export function loadClawForgeConfig(
  baseConfigPath?: string,
  env: NodeJS.ProcessEnv = process.env
): ClawForgeConfig {
  // 1. 加载基础配置（如果有）
  let baseConfig: Partial<ClawForgeConfig> = {};
  
  if (baseConfigPath) {
    try {
      // 这里可以读取 JSON 配置文件
      // baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, 'utf-8'));
      console.log(`加载基础配置：${baseConfigPath}`);
    } catch (error) {
      console.warn(`无法加载基础配置：${error}`);
    }
  }
  
  // 2. 加载运行时配置（从环境变量）
  const runtimeConfig = loadRuntimeConfigFromEnv(env);
  
  // 3. 合并配置
  const config = mergeConfig(baseConfig, runtimeConfig);
  
  // 4. 验证配置
  if (runtimeConfig) {
    if (!validateWorkspacePath(runtimeConfig.workspace, runtimeConfig.orgId, runtimeConfig.userId)) {
      throw new Error('工作目录路径验证失败');
    }
  }
  
  return config;
}

/**
 * 获取当前运行模式
 */
export function getRunMode(env: NodeJS.ProcessEnv = process.env): 'standalone' | 'orchestrator' | 'worker' {
  return (env.OPENCLAW_MODE as any) || 'standalone';
}
