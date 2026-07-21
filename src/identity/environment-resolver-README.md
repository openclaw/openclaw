# Titanium Claws Environment Resolver

Type-safe environment variable management system with validation, default values, and grouping.

## Overview

The `EnvironmentResolver` provides a comprehensive way to access and validate environment variables used by Titanium Claws. It supports:

- **Type-safe access** with automatic parsing
- **Validation** with custom validators
- **Default values** for optional variables
- **Variable grouping** (paths, config, providers, features)
- **Path expansion** for path variables
- **Performance optimization** with caching
- **Comprehensive error handling**

## Installation

```typescript
import {
  EnvironmentResolver,
  getEnvironmentResolver,
} from '@titaniumclaws/identity';
```

## Usage

### Basic Usage

```typescript
import { EnvironmentResolver } from '@titaniumclaws/identity';

const resolver = new EnvironmentResolver();

// Get individual variables
const logLevel = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
const port = resolver.get(EnvironmentResolver.CONFIG_PORT);
const debug = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
```

### Singleton Pattern

```typescript
import { getEnvironmentResolver } from '@titaniumclaws/identity';

const resolver = getEnvironmentResolver();
const logLevel = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
```

### Custom Options

```typescript
const resolver = new EnvironmentResolver({
  env: customEnvObject,
  validateOnInit: true,
  pathResolver: customPathResolver,
});
```

## API Reference

### Constructor

#### `new EnvironmentResolver(options?: EnvironmentResolverOptions)`

Creates a new EnvironmentResolver instance.

**Options:**
- `env`: Custom environment object (defaults to `process.env`)
- `validateOnInit`: Validate all variables on initialization (defaults to `false`)
- `pathResolver`: PathResolver instance for path expansion

### Core Methods

#### `get<T>(definition: EnvVarDefinition<T>): T | undefined`

Gets environment variable value with type-safe parsing.

**Example:**
```typescript
const logLevel = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
// Returns: 'info' | 'debug' | 'warn' | 'error'

const port = resolver.get(EnvironmentResolver.CONFIG_PORT);
// Returns: number

const debug = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
// Returns: boolean
```

#### `getOrDefault<T>(definition: EnvVarDefinition<T>, defaultValue: T): T`

Gets environment variable with fallback default value.

**Example:**
```typescript
const logLevel = resolver.getOrDefault(
  EnvironmentResolver.CONFIG_LOG_LEVEL,
  'info'
);
```

#### `has(definition: EnvVarDefinition): boolean`

Checks if environment variable is set.

**Example:**
```typescript
if (resolver.has(EnvironmentResolver.PROVIDER_ANTHROPIC_API_KEY)) {
  console.log('Anthropic API key is configured');
}
```

### Group Methods

#### `getPaths(): Record<string, string | undefined>`

Gets all path-related environment variables.

**Example:**
```typescript
const paths = resolver.getPaths();
console.log(paths.TITANIUM_CLAWS_STATE_DIR);
console.log(paths.TITANIUM_CLAWS_CONFIG_PATH);
```

#### `getConfig(): Record<string, unknown>`

Gets all configuration environment variables.

**Example:**
```typescript
const config = resolver.getConfig();
console.log(config.TITANIUM_CLAWS_LOG_LEVEL);
console.log(config.TITANIUM_CLAWS_PORT);
```

#### `getProviders(): Record<string, string | undefined>`

Gets all provider API keys.

**Example:**
```typescript
const providers = resolver.getProviders();
console.log(providers.ANTHROPIC_API_KEY);
console.log(providers.OPENAI_API_KEY);
```

#### `getFeatures(): Record<string, boolean>`

Gets all feature flags.

**Example:**
```typescript
const features = resolver.getFeatures();
console.log(features.TITANIUM_CLAWS_FEATURE_RUST_ENGINES);
console.log(features.TITANIUM_CLAWS_FEATURE_MULTI_AGENT);
```

#### `getAll(): Record<string, unknown>`

Gets all environment variables.

**Example:**
```typescript
const all = resolver.getAll();
console.log(all);
```

### Validation Methods

#### `validate(definition: EnvVarDefinition): boolean`

Validates a single environment variable.

**Example:**
```typescript
const isValid = resolver.validate(EnvironmentResolver.CONFIG_LOG_LEVEL);
if (!isValid) {
  console.error('Invalid log level');
}
```

#### `validateAll(): EnvValidationResult`

Validates all environment variables.

**Returns:**
```typescript
interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

**Example:**
```typescript
const result = resolver.validateAll();
if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

#### `validateGroup(groupName: string): EnvValidationResult`

Validates a specific group of variables.

**Example:**
```typescript
const result = resolver.validateGroup('paths');
if (!result.valid) {
  console.error('Path validation failed:', result.errors);
}
```

### Group Management

#### `getGroup(groupName: string): EnvGroup | undefined`

Gets group definition by name.

**Example:**
```typescript
const pathsGroup = resolver.getGroup('paths');
console.log(pathsGroup?.variables);
```

#### `getGroups(): EnvGroup[]`

Gets all group definitions.

**Example:**
```typescript
const groups = resolver.getGroups();
groups.forEach(group => {
  console.log(`${group.name}: ${group.description}`);
});
```

### Cache Management

#### `clearCache(): void`

Clears the value and validation cache.

**Example:**
```typescript
resolver.clearCache();
```

### Export and Display

#### `exportAsJson(): string`

Exports all variables and validation results as JSON.

**Example:**
```typescript
const json = resolver.exportAsJson();
fs.writeFileSync('env.json', json);
```

#### `formatForDisplay(): string`

Formats all variables for human-readable display.

**Example:**
```typescript
console.log(resolver.formatForDisplay());
// Output:
// Environment Variables:
// 
// [PATHS] Path-related environment variables
//   ✓ TITANIUM_CLAWS_STATE_DIR: ~/state
//   ✗ TITANIUM_CLAWS_CONFIG_PATH: (not set)
// ...
```

### Singleton Methods

#### `static getInstance(): EnvironmentResolver`

Gets the singleton instance.

**Example:**
```typescript
const resolver = EnvironmentResolver.getInstance();
```

#### `static resetInstance(): void`

Resets the singleton instance (for testing).

**Example:**
```typescript
EnvironmentResolver.resetInstance();
```

## Environment Variables

### Path Variables

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `TITANIUM_CLAWS_STATE_DIR` | path | No | Override state directory path |
| `TITANIUM_CLAWS_CONFIG_PATH` | path | No | Override configuration file path |
| `TITANIUM_CLAWS_DATABASE_PATH` | path | No | Override database file path |
| `TITANIUM_CLAWS_LOG_PATH` | path | No | Override log file path |
| `TITANIUM_CLAWS_CACHE_PATH` | path | No | Override cache directory path |
| `TITANIUM_CLAWS_TEMP_PATH` | path | No | Override temporary directory path |
| `TITANIUM_CLAWS_PLUGINS_PATH` | path | No | Override plugins directory path |
| `TITANIUM_CLAWS_WORKSPACE_PATH` | path | No | Override workspace directory path |

### Configuration Variables

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `TITANIUM_CLAWS_LOG_LEVEL` | string | No | `info` | Logging level (debug, info, warn, error) |
| `TITANIUM_CLAWS_DEBUG` | boolean | No | `false` | Enable debug mode |
| `TITANIUM_CLAWS_ENVIRONMENT` | string | No | `production` | Environment (development, staging, production) |
| `TITANIUM_CLAWS_PORT` | number | No | `3000` | Server port |

### Provider API Keys

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `ANTHROPIC_API_KEY` | string | No | Anthropic API key |
| `OPENAI_API_KEY` | string | No | OpenAI API key |
| `GOOGLE_API_KEY` | string | No | Google API key |

### Feature Flags

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `TITANIUM_CLAWS_FEATURE_RUST_ENGINES` | boolean | No | `true` | Enable Rust engines |
| `TITANIUM_CLAWS_FEATURE_MULTI_AGENT` | boolean | No | `true` | Enable multi-agent system |
| `TITANIUM_CLAWS_FEATURE_A2A_PROTOCOL` | boolean | No | `true` | Enable A2A protocol |
| `TITANIUM_CLAWS_FEATURE_CAUSAL_GRAPH` | boolean | No | `true` | Enable causal graph |

## Variable Groups

### Paths Group

Path-related environment variables for filesystem paths.

```typescript
const paths = resolver.getPaths();
console.log(paths.TITANIUM_CLAWS_STATE_DIR);
```

### Config Group

Configuration environment variables for application behavior.

```typescript
const config = resolver.getConfig();
console.log(config.TITANIUM_CLAWS_LOG_LEVEL);
```

### Providers Group

Provider API keys for LLM providers.

```typescript
const providers = resolver.getProviders();
console.log(providers.ANTHROPIC_API_KEY);
```

### Features Group

Feature flags for enabling/disabling features.

```typescript
const features = resolver.getFeatures();
console.log(features.TITANIUM_CLAWS_FEATURE_RUST_ENGINES);
```

## Type Parsing

### String Values

```typescript
// Environment: TITANIUM_CLAWS_LOG_LEVEL=debug
const value = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
// Returns: 'debug' (string)
```

### Number Values

```typescript
// Environment: TITANIUM_CLAWS_PORT=8080
const value = resolver.get(EnvironmentResolver.CONFIG_PORT);
// Returns: 8080 (number)
```

### Boolean Values

```typescript
// Environment: TITANIUM_CLAWS_DEBUG=true
const value = resolver.get(EnvironmentResolver.CONFIG_DEBUG);
// Returns: true (boolean)

// Also accepts: '1', 'TRUE', 'True'
```

### Path Values

```typescript
// Environment: TITANIUM_CLAWS_STATE_DIR=~/state
const value = resolver.get(EnvironmentResolver.PATH_STATE_DIR);
// Returns: '/home/user/state' (expanded path)
```

## Validation

### Built-in Validation

Some variables have built-in validation:

```typescript
// TITANIUM_CLAWS_LOG_LEVEL must be: debug, info, warn, error
// TITANIUM_CLAWS_PORT must be: 1-65535
// TITANIUM_CLAWS_ENVIRONMENT must be: development, staging, production
```

### Custom Validation

Define custom validators:

```typescript
const customVar = {
  name: 'CUSTOM_VAR',
  type: 'string',
  required: false,
  description: 'Custom variable',
  validate: (value: string) => value.startsWith('prefix'),
};
```

## Error Handling

### Missing Required Variables

```typescript
try {
  const value = resolver.get(requiredVar);
} catch (error) {
  if (error.code === IdentityErrorCode.MISSING_REQUIRED_ENV_VAR) {
    console.error('Required variable is missing');
  }
}
```

### Invalid Values

```typescript
try {
  const value = resolver.get(EnvironmentResolver.CONFIG_PORT);
} catch (error) {
  if (error.code === IdentityErrorCode.INVALID_ENV_VAR) {
    console.error('Invalid value');
  }
}
```

## Examples

### Basic Configuration

```typescript
import { EnvironmentResolver } from '@titaniumclaws/identity';

const resolver = new EnvironmentResolver();

// Get configuration
const logLevel = resolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
const port = resolver.get(EnvironmentResolver.CONFIG_PORT);
const debug = resolver.get(EnvironmentResolver.CONFIG_DEBUG);

console.log(`Starting server on port ${port}`);
console.log(`Log level: ${logLevel}`);
console.log(`Debug mode: ${debug}`);
```

### Provider Configuration

```typescript
import { EnvironmentResolver } from '@titaniumclaws/identity';

const resolver = new EnvironmentResolver();

// Check for API keys
if (resolver.has(EnvironmentResolver.PROVIDER_ANTHROPIC_API_KEY)) {
  const apiKey = resolver.get(EnvironmentResolver.PROVIDER_ANTHROPIC_API_KEY);
  console.log('Using Anthropic API');
} else if (resolver.has(EnvironmentResolver.PROVIDER_OPENAI_API_KEY)) {
  const apiKey = resolver.get(EnvironmentResolver.PROVIDER_OPENAI_API_KEY);
  console.log('Using OpenAI API');
} else {
  console.warn('No API keys configured');
}
```

### Feature Flags

```typescript
import { EnvironmentResolver } from '@titaniumclaws/identity';

const resolver = new EnvironmentResolver();

const features = resolver.getFeatures();

if (features.TITANIUM_CLAWS_FEATURE_RUST_ENGINES) {
  console.log('Rust engines enabled');
}

if (features.TITANIUM_CLAWS_FEATURE_MULTI_AGENT) {
  console.log('Multi-agent system enabled');
}
```

### Validation

```typescript
import { EnvironmentResolver } from '@titaniumclaws/identity';

const resolver = new EnvironmentResolver();

// Validate all variables
const result = resolver.validateAll();

if (!result.valid) {
  console.error('Environment validation failed:');
  result.errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

if (result.warnings.length > 0) {
  console.warn('Environment warnings:');
  result.warnings.forEach(warning => console.warn(`  - ${warning}`));
}

console.log('Environment validation passed');
```

### Export and Display

```typescript
import { EnvironmentResolver } from '@titaniumclaws/identity';
import * as fs from 'fs';

const resolver = new EnvironmentResolver();

// Export as JSON
const json = resolver.exportAsJson();
fs.writeFileSync('env-config.json', json);

// Display formatted
console.log(resolver.formatForDisplay());
```

## Integration with Other Components

### With PathResolver

```typescript
import { PathResolver, EnvironmentResolver } from '@titaniumclaws/identity';

const pathResolver = new PathResolver();
const envResolver = new EnvironmentResolver({ pathResolver });

// Path variables are automatically expanded
const stateDir = envResolver.get(EnvironmentResolver.PATH_STATE_DIR);
// Returns: expanded path
```

### With IdentityService

```typescript
import { IdentityService, EnvironmentResolver } from '@titaniumclaws/identity';

const identityService = new IdentityService();
const envResolver = new EnvironmentResolver();

// Use environment variables for configuration
const logLevel = envResolver.get(EnvironmentResolver.CONFIG_LOG_LEVEL);
console.log(`${identityService.getDisplayName()} starting...`);
```

## Best Practices

### 1. Validate on Startup

```typescript
const resolver = new EnvironmentResolver({ validateOnInit: true });
```

### 2. Use Type-Safe Access

```typescript
// Good
const port = resolver.get(EnvironmentResolver.CONFIG_PORT);

// Avoid
const port = parseInt(process.env.PORT || '3000');
```

### 3. Group Related Variables

```typescript
const paths = resolver.getPaths();
const config = resolver.getConfig();
```

### 4. Handle Missing Values

```typescript
const apiKey = resolver.getOrDefault(
  EnvironmentResolver.PROVIDER_ANTHROPIC_API_KEY,
  ''
);
```

### 5. Validate Groups

```typescript
const pathValidation = resolver.validateGroup('paths');
if (!pathValidation.valid) {
  console.error('Path configuration invalid');
}
```

### 6. Clear Cache on Changes

```typescript
// After changing environment variables
resolver.clearCache();
```

## Performance

The EnvironmentResolver is optimized for performance:

- **Caching**: Values are cached after first retrieval
- **Lazy Validation**: Validation is performed only when requested
- **Efficient Parsing**: Minimal parsing overhead

## Security

The EnvironmentResolver follows security best practices:

- **Type Safety**: Prevents type-related errors
- **Validation**: Validates all values before use
- **No Sensitive Logging**: API keys are not logged
- **Path Expansion**: Prevents path traversal attacks

## Testing

### Reset Singleton in Tests

```typescript
import { resetEnvironmentResolver } from '@titaniumclaws/identity';

beforeEach(() => {
  resetEnvironmentResolver();
});
```

### Mock Environment Variables

```typescript
const mockEnv = {
  TITANIUM_CLAWS_LOG_LEVEL: 'debug',
  TITANIUM_CLAWS_PORT: '8080',
};

const resolver = new EnvironmentResolver({ env: mockEnv });
```

## Troubleshooting

### Issue: Variables not being read

**Solution:**
```typescript
// Clear cache
resolver.clearCache();

// Check environment
console.log(process.env.TITANIUM_CLAWS_LOG_LEVEL);
```

### Issue: Validation errors

**Solution:**
```typescript
const result = resolver.validateAll();
console.error('Errors:', result.errors);
console.warn('Warnings:', result.warnings);
```

### Issue: Invalid boolean values

**Solution:**
```typescript
// Accepts: 'true', 'TRUE', 'True', '1'
// Rejects: 'yes', 'on', 'enabled'
```

### Issue: Path expansion not working

**Solution:**
```typescript
// Ensure PathResolver is configured
const pathResolver = new PathResolver();
const resolver = new EnvironmentResolver({ pathResolver });
```

## Related Documentation

- [PathResolver](./path-resolver-README.md) - Path resolution system
- [IdentityService](./identity-service-README.md) - High-level identity API
- [Constants](./constants.ts) - Product identity constants
- [Types](./types.ts) - TypeScript type definitions
- [Errors](./errors.ts) - Error classes and codes

## License

MIT License - see LICENSE file for details.

## Support

- **Documentation**: https://docs.titaniumclaws.ai
- **GitHub Issues**: https://github.com/titaniumclaws/titaniumclaws/issues
- **Discord**: https://discord.gg/titaniumclaws

---

**The EnvironmentResolver provides type-safe environment variable management with validation and grouping. 🦞⚡**
