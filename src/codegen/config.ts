/**
 * 配置系统 - 仿照 Crush (opencode) 的配置方式
 *
 * 配置文件搜索顺序（优先级从低到高）：
 * 1. ~/.config/openclaw/openclaw.json  （全局）
 * 2. .openclaw.json / openclaw.json    （从 CWD 向上搜索）
 *
 * 支持：
 * - 多 Provider 配置
 * - 模型 fallback
 * - 环境变量引用 ($ENV_VAR)
 * - openai-compat 类型（中转服务）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ========== 类型定义 ==========

export type ProviderType = 'openai' | 'openai-compat' | 'anthropic';

export interface ProviderConfig {
  name?: string;
  type: ProviderType;
  api_key: string;
  base_url?: string;
  models?: string[];
  extra_headers?: Record<string, string>;
  disable?: boolean;
}

export interface SelectedModel {
  provider: string;
  model: string;
  max_tokens?: number;
  temperature?: number;
}

export interface OpenClawConfig {
  providers: Record<string, ProviderConfig>;
  models: {
    large: SelectedModel;
    small?: SelectedModel;
  };
}

// ========== 默认配置 ==========

const DEFAULT_CONFIG: OpenClawConfig = {
  providers: {},
  models: {
    large: {
      provider: 'default',
      model: 'claude-sonnet-4-5-20250929',
    },
  },
};

// ========== 配置加载 ==========

/**
 * 解析配置值中的环境变量引用
 * 支持 $ENV_VAR 和 ${ENV_VAR} 格式
 */
function resolveValue(value: string): string {
  if (!value) return value;

  // 处理 ${VAR} 格式
  let resolved = value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });

  // 处理 $VAR 格式（仅当整个值是一个环境变量引用时）
  if (resolved.startsWith('$') && !resolved.startsWith('${')) {
    const varName = resolved.slice(1);
    const envVal = process.env[varName];
    if (envVal) return envVal;
  }

  return resolved;
}

/**
 * 从 CWD 向上搜索配置文件
 */
function findConfigFiles(): string[] {
  const files: string[] = [];
  const configNames = ['.openclaw.json', 'openclaw.json'];

  // 1. 从 CWD 向上搜索
  let dir = process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    for (const name of configNames) {
      const filePath = path.join(dir, name);
      if (fs.existsSync(filePath)) {
        files.push(filePath);
      }
    }
    dir = path.dirname(dir);
  }

  // 2. 全局配置
  const globalConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const globalConfig = path.join(globalConfigDir, 'openclaw', 'openclaw.json');
  if (fs.existsSync(globalConfig)) {
    files.push(globalConfig);
  }

  // 反转，让全局配置优先级最低，项目配置优先级最高
  return files.reverse();
}

/**
 * 深度合并两个对象
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * 加载并合并所有配置文件
 */
export function loadConfig(): OpenClawConfig {
  let config = { ...DEFAULT_CONFIG };

  const configFiles = findConfigFiles();

  for (const filePath of configFiles) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      config = deepMerge(config, parsed);
    } catch {
      // 配置文件解析失败，跳过
    }
  }

  // 环境变量覆盖（兼容旧配置方式）
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) {
    config.providers['env'] = {
      type: 'openai-compat',
      api_key: process.env.LLM_API_KEY,
      base_url: process.env.LLM_BASE_URL,
    };
    if (!config.models.large.provider || config.models.large.provider === 'default') {
      config.models.large = {
        provider: 'env',
        model: process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929',
      };
    }
  }

  // 自动检测环境变量中的 API Key
  if (!config.providers['anthropic'] && process.env.ANTHROPIC_API_KEY) {
    config.providers['anthropic'] = {
      type: 'anthropic',
      api_key: '$ANTHROPIC_API_KEY',
    };
  }
  if (!config.providers['openai'] && process.env.OPENAI_API_KEY) {
    config.providers['openai'] = {
      type: 'openai',
      api_key: '$OPENAI_API_KEY',
      base_url: 'https://api.openai.com/v1',
    };
  }

  return config;
}

/**
 * 解析 Provider 配置中的变量
 */
export function resolveProvider(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    api_key: resolveValue(provider.api_key),
    base_url: provider.base_url ? resolveValue(provider.base_url) : undefined,
  };
}

/**
 * 保存配置到文件
 */
export function saveConfig(config: OpenClawConfig, filePath?: string): string {
  const targetPath = filePath || path.join(process.cwd(), '.openclaw.json');
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return targetPath;
}

/**
 * 保存到全局配置
 */
export function saveGlobalConfig(config: OpenClawConfig): string {
  const globalConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const targetPath = path.join(globalConfigDir, 'openclaw', 'openclaw.json');
  return saveConfig(config, targetPath);
}

/**
 * 获取当前活跃的 Provider 配置
 */
export function getActiveProvider(config: OpenClawConfig): {
  provider: ProviderConfig;
  model: string;
} {
  const modelConfig = config.models.large;
  const providerKey = modelConfig.provider;
  const providerConfig = config.providers[providerKey];

  if (!providerConfig) {
    throw new Error(
      `Provider "${providerKey}" not found in config. ` +
      `Available providers: ${Object.keys(config.providers).join(', ') || 'none'}`
    );
  }

  return {
    provider: resolveProvider(providerConfig),
    model: modelConfig.model,
  };
}

/**
 * 获取配置文件路径信息
 */
export function getConfigPaths(): { found: string[]; global: string } {
  const globalConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return {
    found: findConfigFiles(),
    global: path.join(globalConfigDir, 'openclaw', 'openclaw.json'),
  };
}
