/**
 * Titanium Claws Environment Resolver
 * 
 * Provides type-safe access to environment variables with validation,
 * default values, and grouping.
 */

import { IdentityError, IdentityErrorCode } from './errors.js';
import { PathResolver, getPathResolver } from './path-resolver.js';

/**
 * Environment variable types
 */
export type EnvType = 'string' | 'number' | 'boolean' | 'path';

/**
 * Environment variable definition
 */
export interface EnvVarDefinition<T = string> {
  readonly name: string;
  readonly type: EnvType;
  readonly required: boolean;
  readonly default?: T;
  readonly description: string;
  readonly validate?: (value: T) => boolean;
}

/**
 * Environment resolver options
 */
export interface EnvironmentResolverOptions {
  /**
   * Custom environment object (defaults to process.env)
   */
  readonly env?: NodeJS.ProcessEnv;
  
  /**
   * Whether to validate all variables on initialization
   */
  readonly validateOnInit?: boolean;
  
  /**
   * PathResolver instance for path expansion
   */
  readonly pathResolver?: PathResolver;
}

/**
 * Environment validation result
 */
export interface EnvValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * Environment group
 */
export interface EnvGroup {
  readonly name: string;
  readonly description: string;
  readonly variables: EnvVarDefinition[];
}

/**
 * EnvironmentResolver - Type-safe environment variable management
 * 
 * Features:
 * - Type-safe access to environment variables
 * - Validation and default values
 * - Variable grouping (paths, config, debug, providers, features)
 * - Path expansion support
 * - Performance optimization with caching
 * - Comprehensive error handling
 */
export class EnvironmentResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly pathResolver: PathResolver;
  private readonly cache: Map<string, unknown> = new Map();
  private readonly validationCache: Map<string, boolean> = new Map();

  // Path environment variables
  static readonly PATH_STATE_DIR: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_STATE_DIR',
    type: 'path',
    required: false,
    description: 'Override state directory path',
  };

  static readonly PATH_CONFIG_PATH: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_CONFIG_PATH',
    type: 'path',
    required: false,
    description: 'Override configuration file path',
  };

  static readonly PATH_DATABASE_PATH: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_DATABASE_PATH',
    type: 'path',
    required: false,
    description: 'Override database file path',
  };

  static readonly PATH_LOG_PATH: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_LOG_PATH',
    type: 'path',
    required: false,
    description: 'Override log file path',
  };

  static readonly PATH_CACHE_PATH: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_CACHE_PATH',
    type: 'path',
    required: false,
    description: 'Override cache directory path',
  };

  static readonly PATH_TEMP_PATH: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_TEMP_PATH',
    type: 'path',
    required: false,
    description: 'Override temporary directory path',
  };

  static readonly PATH_PLUGINS_PATH: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_PLUGINS_PATH',
    type: 'path',
    required: false,
    description: 'Override plugins directory path',
  };

  static readonly PATH_WORKSPACE_PATH: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_WORKSPACE_PATH',
    type: 'path',
    required: false,
    description: 'Override workspace directory path',
  };

  // Configuration environment variables
  static readonly CONFIG_LOG_LEVEL: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_LOG_LEVEL',
    type: 'string',
    required: false,
    default: 'info',
    description: 'Logging level (debug, info, warn, error)',
    validate: (value: string) => ['debug', 'info', 'warn', 'error'].includes(value),
  };

  static readonly CONFIG_DEBUG: EnvVarDefinition<boolean> = {
    name: 'TITANIUM_CLAWS_DEBUG',
    type: 'boolean',
    required: false,
    default: false,
    description: 'Enable debug mode',
  };

  static readonly CONFIG_ENVIRONMENT: EnvVarDefinition<string> = {
    name: 'TITANIUM_CLAWS_ENVIRONMENT',
    type: 'string',
    required: false,
    default: 'production',
    description: 'Environment (development, staging, production)',
    validate: (value: string) => ['development', 'staging', 'production'].includes(value),
  };

  static readonly CONFIG_PORT: EnvVarDefinition<number> = {
    name: 'TITANIUM_CLAWS_PORT',
    type: 'number',
    required: false,
    default: 3000,
    description: 'Server port',
    validate: (value: number) => value > 0 && value < 65536,
  };

  // Provider API keys
  static readonly PROVIDER_ANTHROPIC_API_KEY: EnvVarDefinition<string> = {
    name: 'ANTHROPIC_API_KEY',
    type: 'string',
    required: false,
    description: 'Anthropic API key',
  };

  static readonly PROVIDER_OPENAI_API_KEY: EnvVarDefinition<string> = {
    name: 'OPENAI_API_KEY',
    type: 'string',
    required: false,
    description: 'OpenAI API key',
  };

  static readonly PROVIDER_GOOGLE_API_KEY: EnvVarDefinition<string> = {
    name: 'GOOGLE_API_KEY',
    type: 'string',
    required: false,
    description: 'Google API key',
  };

  // Feature flags
  static readonly FEATURE_RUST_ENGINES: EnvVarDefinition<boolean> = {
    name: 'TITANIUM_CLAWS_FEATURE_RUST_ENGINES',
    type: 'boolean',
    required: false,
    default: true,
    description: 'Enable Rust engines',
  };

  static readonly FEATURE_MULTI_AGENT: EnvVarDefinition<boolean> = {
    name: 'TITANIUM_CLAWS_FEATURE_MULTI_AGENT',
    type: 'boolean',
    required: false,
    default: true,
    description: 'Enable multi-agent system',
  };

  static readonly FEATURE_A2A_PROTOCOL: EnvVarDefinition<boolean> = {
    name: 'TITANIUM_CLAWS_FEATURE_A2A_PROTOCOL',
    type: 'boolean',
    required: false,
    default: true,
    description: 'Enable A2A protocol',
  };

  static readonly FEATURE_CAUSAL_GRAPH: EnvVarDefinition<boolean> = {
    name: 'TITANIUM_CLAWS_FEATURE_CAUSAL_GRAPH',
    type: 'boolean',
    required: false,
    default: true,
    description: 'Enable causal graph',
  };

  /**
   * All environment variable definitions
   */
  static readonly ALL_VARIABLES: EnvVarDefinition[] = [
    // Path variables
    EnvironmentResolver.PATH_STATE_DIR,
    EnvironmentResolver.PATH_CONFIG_PATH,
    EnvironmentResolver.PATH_DATABASE_PATH,
    EnvironmentResolver.PATH_LOG_PATH,
    EnvironmentResolver.PATH_CACHE_PATH,
    EnvironmentResolver.PATH_TEMP_PATH,
    EnvironmentResolver.PATH_PLUGINS_PATH,
    EnvironmentResolver.PATH_WORKSPACE_PATH,
    // Configuration variables
    EnvironmentResolver.CONFIG_LOG_LEVEL,
    EnvironmentResolver.CONFIG_DEBUG,
    EnvironmentResolver.CONFIG_ENVIRONMENT,
    EnvironmentResolver.CONFIG_PORT,
    // Provider API keys
    EnvironmentResolver.PROVIDER_ANTHROPIC_API_KEY,
    EnvironmentResolver.PROVIDER_OPENAI_API_KEY,
    EnvironmentResolver.PROVIDER_GOOGLE_API_KEY,
    // Feature flags
    EnvironmentResolver.FEATURE_RUST_ENGINES,
    EnvironmentResolver.FEATURE_MULTI_AGENT,
    EnvironmentResolver.FEATURE_A2A_PROTOCOL,
    EnvironmentResolver.FEATURE_CAUSAL_GRAPH,
  ];

  /**
   * Environment variable groups
   */
  static readonly GROUPS: EnvGroup[] = [
    {
      name: 'paths',
      description: 'Path-related environment variables',
      variables: [
        EnvironmentResolver.PATH_STATE_DIR,
        EnvironmentResolver.PATH_CONFIG_PATH,
        EnvironmentResolver.PATH_DATABASE_PATH,
        EnvironmentResolver.PATH_LOG_PATH,
        EnvironmentResolver.PATH_CACHE_PATH,
        EnvironmentResolver.PATH_TEMP_PATH,
        EnvironmentResolver.PATH_PLUGINS_PATH,
        EnvironmentResolver.PATH_WORKSPACE_PATH,
      ],
    },
    {
      name: 'config',
      description: 'Configuration environment variables',
      variables: [
        EnvironmentResolver.CONFIG_LOG_LEVEL,
        EnvironmentResolver.CONFIG_DEBUG,
        EnvironmentResolver.CONFIG_ENVIRONMENT,
        EnvironmentResolver.CONFIG_PORT,
      ],
    },
    {
      name: 'providers',
      description: 'Provider API keys',
      variables: [
        EnvironmentResolver.PROVIDER_ANTHROPIC_API_KEY,
        EnvironmentResolver.PROVIDER_OPENAI_API_KEY,
        EnvironmentResolver.PROVIDER_GOOGLE_API_KEY,
      ],
    },
    {
      name: 'features',
      description: 'Feature flags',
      variables: [
        EnvironmentResolver.FEATURE_RUST_ENGINES,
        EnvironmentResolver.FEATURE_MULTI_AGENT,
        EnvironmentResolver.FEATURE_A2A_PROTOCOL,
        EnvironmentResolver.FEATURE_CAUSAL_GRAPH,
      ],
    },
  ];

  /**
   * Create a new EnvironmentResolver instance
   */
  constructor(options: EnvironmentResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.pathResolver = options.pathResolver ?? getPathResolver();

    if (options.validateOnInit) {
      this.validateAll();
    }
  }

  /**
   * Get environment variable value
   */
  get<T = string>(definition: EnvVarDefinition<T>): T | undefined {
    const cacheKey = definition.name;
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as T;
    }

    const rawValue = this.env[definition.name];
    
    if (rawValue === undefined) {
      if (definition.required) {
        throw new IdentityError(
          `Required environment variable ${definition.name} is not set`,
          IdentityErrorCode.MISSING_REQUIRED_ENV_VAR,
          undefined,
          { variable: definition.name },
        );
      }
      return definition.default;
    }

    const value = this.parseValue<T>(rawValue, definition.type);
    
    if (definition.validate && !definition.validate(value)) {
      throw new IdentityError(
        `Environment variable ${definition.name} has invalid value: ${rawValue}`,
        IdentityErrorCode.INVALID_ENV_VAR,
        undefined,
        { variable: definition.name, value: rawValue },
      );
    }

    this.cache.set(cacheKey, value);
    return value;
  }

  /**
   * Get environment variable with default value
   */
  getOrDefault<T = string>(definition: EnvVarDefinition<T>, defaultValue: T): T {
    try {
      return this.get(definition) ?? defaultValue;
    } catch {
      return defaultValue;
    }
  }

  /**
   * Check if environment variable is set
   */
  has(definition: EnvVarDefinition): boolean {
    return this.env[definition.name] !== undefined;
  }

  /**
   * Get all path environment variables
   */
  getPaths(): Record<string, string | undefined> {
    const paths: Record<string, string | undefined> = {};
    
    for (const variable of EnvironmentResolver.GROUPS[0].variables) {
      paths[variable.name] = this.get(variable);
    }
    
    return paths;
  }

  /**
   * Get all configuration environment variables
   */
  getConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    
    for (const variable of EnvironmentResolver.GROUPS[1].variables) {
      config[variable.name] = this.get(variable);
    }
    
    return config;
  }

  /**
   * Get all provider API keys
   */
  getProviders(): Record<string, string | undefined> {
    const providers: Record<string, string | undefined> = {};
    
    for (const variable of EnvironmentResolver.GROUPS[2].variables) {
      providers[variable.name] = this.get(variable);
    }
    
    return providers;
  }

  /**
   * Get all feature flags
   */
  getFeatures(): Record<string, boolean> {
    const features: Record<string, boolean> = {};
    
    for (const variable of EnvironmentResolver.GROUPS[3].variables) {
      features[variable.name] = this.getOrDefault(variable, variable.default as boolean);
    }
    
    return features;
  }

  /**
   * Get all environment variables
   */
  getAll(): Record<string, unknown> {
    const all: Record<string, unknown> = {};
    
    for (const variable of EnvironmentResolver.ALL_VARIABLES) {
      try {
        all[variable.name] = this.get(variable);
      } catch {
        all[variable.name] = undefined;
      }
    }
    
    return all;
  }

  /**
   * Validate a single environment variable
   */
  validate(definition: EnvVarDefinition): boolean {
    const cacheKey = `validation:${definition.name}`;
    
    if (this.validationCache.has(cacheKey)) {
      return this.validationCache.get(cacheKey)!;
    }

    const rawValue = this.env[definition.name];
    
    if (rawValue === undefined) {
      const isValid = !definition.required;
      this.validationCache.set(cacheKey, isValid);
      return isValid;
    }

    try {
      const value = this.parseValue(rawValue, definition.type);
      
      if (definition.validate && !definition.validate(value)) {
        this.validationCache.set(cacheKey, false);
        return false;
      }
      
      this.validationCache.set(cacheKey, true);
      return true;
    } catch {
      this.validationCache.set(cacheKey, false);
      return false;
    }
  }

  /**
   * Validate all environment variables
   */
  validateAll(): EnvValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const variable of EnvironmentResolver.ALL_VARIABLES) {
      if (!this.validate(variable)) {
        if (variable.required) {
          errors.push(`Required variable ${variable.name} is missing or invalid`);
        } else {
          warnings.push(`Variable ${variable.name} is invalid (optional)`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a specific group
   */
  validateGroup(groupName: string): EnvValidationResult {
    const group = EnvironmentResolver.GROUPS.find(g => g.name === groupName);
    
    if (!group) {
      return {
        valid: false,
        errors: [`Unknown group: ${groupName}`],
        warnings: [],
      };
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    for (const variable of group.variables) {
      if (!this.validate(variable)) {
        if (variable.required) {
          errors.push(`Required variable ${variable.name} is missing or invalid`);
        } else {
          warnings.push(`Variable ${variable.name} is invalid (optional)`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Get group by name
   */
  getGroup(groupName: string): EnvGroup | undefined {
    return EnvironmentResolver.GROUPS.find(g => g.name === groupName);
  }

  /**
   * Get all groups
   */
  getGroups(): EnvGroup[] {
    return [...EnvironmentResolver.GROUPS];
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.validationCache.clear();
  }

  /**
   * Export as JSON
   */
  exportAsJson(): string {
    const all = this.getAll();
    const validation = this.validateAll();
    
    return JSON.stringify({
      variables: all,
      validation,
      groups: EnvironmentResolver.GROUPS.map(g => ({
        name: g.name,
        description: g.description,
        count: g.variables.length,
      })),
    }, null, 2);
  }

  /**
   * Format for display
   */
  formatForDisplay(): string {
    const lines: string[] = [];
    
    lines.push('Environment Variables:');
    lines.push('');
    
    for (const group of EnvironmentResolver.GROUPS) {
      lines.push(`[${group.name.toUpperCase()}] ${group.description}`);
      
      for (const variable of group.variables) {
        const value = this.env[variable.name];
        const status = value ? '✓' : '✗';
        lines.push(`  ${status} ${variable.name}: ${value ?? '(not set)'}`);
      }
      
      lines.push('');
    }
    
    return lines.join('\n');
  }

  /**
   * Parse raw value to typed value
   */
  private parseValue<T>(rawValue: string, type: EnvType): T {
    switch (type) {
      case 'string':
        return rawValue as unknown as T;
      
      case 'number': {
        const num = parseInt(rawValue, 10);
        if (isNaN(num)) {
          throw new IdentityError(
            `Cannot parse "${rawValue}" as number`,
            IdentityErrorCode.INVALID_ENV_VAR,
          );
        }
        return num as unknown as T;
      }
      
      case 'boolean':
        return (rawValue.toLowerCase() === 'true' || rawValue === '1') as unknown as T;
      
      case 'path':
        return this.pathResolver.expandPath(rawValue) as unknown as T;
      
      default:
        return rawValue as unknown as T;
    }
  }

  /**
   * Singleton instance
   */
  private static instance: EnvironmentResolver | null = null;

  /**
   * Get singleton instance
   */
  static getInstance(): EnvironmentResolver {
    if (!EnvironmentResolver.instance) {
      EnvironmentResolver.instance = new EnvironmentResolver();
    }
    return EnvironmentResolver.instance;
  }

  /**
   * Reset singleton instance
   */
  static resetInstance(): void {
    EnvironmentResolver.instance = null;
  }
}

/**
 * Get singleton EnvironmentResolver instance
 */
export function getEnvironmentResolver(): EnvironmentResolver {
  return EnvironmentResolver.getInstance();
}

/**
 * Reset singleton EnvironmentResolver instance
 */
export function resetEnvironmentResolver(): void {
  EnvironmentResolver.resetInstance();
}
