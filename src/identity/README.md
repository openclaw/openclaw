# Titanium Claws Identity Layer

Centralized product identity management for Titanium Claws, providing a single source of truth for all identity-related information.

## Overview

The Identity Layer is the foundation of Titanium Claws, providing:

- **Product Identity**: Centralized product metadata and branding
- **Path Management**: Filesystem path resolution with backward compatibility
- **Environment Variables**: Environment variable resolution and validation
- **Error Handling**: Comprehensive error classes and codes
- **Type Safety**: Full TypeScript type definitions

## Installation

The Identity Layer is part of the Titanium Claws monorepo. To use it in your project:

```typescript
import {
  PRODUCT_IDENTITY,
  IdentityService,
  PathResolver,
  EnvironmentResolver,
} from '@titanium-claws/identity';
```

## Core Components

### 1. Product Identity

Access product metadata and branding information:

```typescript
import { PRODUCT_IDENTITY } from '@titanium-claws/identity';

console.log(PRODUCT_IDENTITY.displayName); // "Titanium Claws"
console.log(PRODUCT_IDENTITY.version);     // "1.0.0"
console.log(PRODUCT_IDENTITY.urls.website); // "https://titaniumclaws.ai"
```

#### Available Properties

- `displayName`: Full product name ("Titanium Claws")
- `shortName`: Short product name ("Titanium")
- `version`: Current version (semantic versioning)
- `executable`: CLI executable name ("tc")
- `packageScope`: NPM package scope ("@titanium-claws")
- `repository`: GitHub repository ("titanium-claws/titanium-claws")
- `stateDirectory`: State directory name (".titanium-claws")
- `configFile`: Configuration file name ("titanium-claws.json")
- `databaseFile`: Database file name ("titanium-claws.sqlite")
- `logFile`: Log file name ("titanium-claws.log")
- `envPrefix`: Environment variable prefix ("TITANIUM_CLAWS")
- `urls`: Documentation and support URLs
- `legal`: License and copyright information

### 2. Identity Service

High-level API for identity management:

```typescript
import { IdentityService } from '@titanium-claws/identity';

const service = new IdentityService();

// Get product information
const info = service.getProductInfo();
console.log(info.displayName);
console.log(info.version);

// Get branding
const branding = service.getBranding();
console.log(branding.colors.primary);
console.log(branding.typography.fontFamily);

// Get URLs
const urls = service.getUrls();
console.log(urls.website);
console.log(urls.docs);

// Format version string
const versionString = service.getVersionString();
console.log(versionString); // "Titanium Claws v1.0.0"
```

### 3. Path Resolver

Resolve filesystem paths with backward compatibility:

```typescript
import { PathResolver } from '@titanium-claws/identity';

const resolver = new PathResolver();

// Resolve state directory
const stateDir = resolver.resolveStateDirectory();
console.log(stateDir); // "~/.titanium-claws"

// Resolve configuration file
const configPath = resolver.resolveConfigPath();
console.log(configPath); // "~/.titanium-claws/titanium-claws.json"

// Resolve database path
const dbPath = resolver.resolveDatabasePath();
console.log(dbPath); // "~/.titanium-claws/titanium-claws.sqlite"

// Resolve log file
const logPath = resolver.resolveLogPath();
console.log(logPath); // "~/.titanium-claws/titanium-claws.log"

// Resolve cache directory
const cachePath = resolver.resolveCachePath();
console.log(cachePath); // "~/.titanium-claws/cache"

// Resolve temp directory
const tempPath = resolver.resolveTempPath();
console.log(tempPath); // "~/.titanium-claws/temp"

// Resolve plugins directory
const pluginsPath = resolver.resolvePluginsPath();
console.log(pluginsPath); // "~/.titanium-claws/plugins"

// Resolve workspace directory
const workspacePath = resolver.resolveWorkspacePath();
console.log(workspacePath); // "~/.titanium-claws/workspace"
```

#### Fallback Resolution

The PathResolver automatically falls back to legacy paths:

1. New path: `~/.titanium-claws`
2. Legacy path: `~/.openclaw` (if new path doesn't exist)

```typescript
// If ~/.titanium-claws doesn't exist but ~/.openclaw does
const stateDir = resolver.resolveStateDirectory();
console.log(stateDir); // "~/.openclaw" (fallback)
```

### 4. Environment Resolver

Resolve environment variables with dual resolution:

```typescript
import { EnvironmentResolver } from '@titanium-claws/identity';

const resolver = new EnvironmentResolver();

// Resolve environment variables
const env = resolver.resolve();
console.log(env.stateDir);      // State directory from env
console.log(env.gatewayToken);  // Gateway token from env
console.log(env.logLevel);      // Log level from env
console.log(env.databaseUrl);   // Database URL from env
console.log(env.redisUrl);      // Redis URL from env

// Resolve individual variables
const stateDir = resolver.resolveStateDir();
console.log(stateDir);

const token = resolver.resolveGatewayToken();
console.log(token);
```

#### Dual Resolution

The EnvironmentResolver checks both new and legacy environment variables:

1. New variable: `TITANIUM_CLAWS_*`
2. Legacy variable: `OPENCLAW_*` (if new variable not set)

```typescript
// If TITANIUM_CLAWS_STATE_DIR is not set but OPENCLAW_STATE_DIR is
const stateDir = resolver.resolveStateDir();
console.log(stateDir); // Value from OPENCLAW_STATE_DIR
```

#### Validation

Validate environment configuration:

```typescript
const result = resolver.validate();
console.log(result.valid);    // true or false
console.log(result.errors);   // Array of error messages
console.log(result.warnings); // Array of warning messages
```

## Error Handling

The Identity Layer provides comprehensive error classes:

### Error Classes

- `IdentityError`: Base error class for all identity errors
- `ConfigError`: Configuration-related errors
- `PathError`: Path resolution errors
- `EnvironmentError`: Environment variable errors
- `ValidationError`: Validation errors
- `MigrationError`: Migration-related errors
- `CompatibilityError`: Compatibility errors
- `RuntimeError`: Runtime errors

### Error Codes

```typescript
import { IdentityErrorCode } from '@titanium-claws/identity';

// Configuration errors
IdentityErrorCode.INVALID_CONFIG
IdentityErrorCode.MISSING_VERSION
IdentityErrorCode.INVALID_VERSION
IdentityErrorCode.CONFIG_NOT_FOUND
IdentityErrorCode.CONFIG_PARSE_ERROR

// Path errors
IdentityErrorCode.PATH_NOT_FOUND
IdentityErrorCode.PERMISSION_DENIED
IdentityErrorCode.PATH_RESOLUTION_FAILED
IdentityErrorCode.DIRECTORY_CREATION_FAILED

// Environment errors
IdentityErrorCode.INVALID_ENV_VAR
IdentityErrorCode.CONFLICTING_ENV_VARS
IdentityErrorCode.MISSING_REQUIRED_ENV_VAR

// Validation errors
IdentityErrorCode.VALIDATION_FAILED
IdentityErrorCode.INVALID_FIELD
IdentityErrorCode.MISSING_REQUIRED_FIELD

// Migration errors
IdentityErrorCode.MIGRATION_FAILED
IdentityErrorCode.ROLLBACK_FAILED
IdentityErrorCode.MIGRATION_NOT_SUPPORTED

// Compatibility errors
IdentityErrorCode.INCOMPATIBLE_VERSION
IdentityErrorCode.LEGACY_PATH_NOT_FOUND
IdentityErrorCode.LEGACY_ENV_VAR_DEPRECATED

// Runtime errors
IdentityErrorCode.IDENTITY_NOT_INITIALIZED
IdentityErrorCode.IDENTITY_SERVICE_ERROR
IdentityErrorCode.PATH_RESOLVER_ERROR
IdentityErrorCode.ENVIRONMENT_RESOLVER_ERROR
```

### Using Errors

```typescript
import { IdentityError, IdentityErrorCode } from '@titanium-claws/identity';

try {
  // ... code that might throw
} catch (error) {
  if (error instanceof IdentityError) {
    console.log(error.code);    // Error code
    console.log(error.message); // Error message
    console.log(error.cause);   // Original error (if any)
    console.log(error.context); // Additional context (if any)
    
    // Check error type
    if (error.is(IdentityErrorCode.INVALID_CONFIG)) {
      // Handle invalid config error
    }
  }
}
```

### Helper Functions

```typescript
import {
  isIdentityError,
  hasErrorCode,
  createError,
} from '@titanium-claws/identity';

// Check if error is IdentityError
if (isIdentityError(error)) {
  console.log('Identity error detected');
}

// Check error code
if (hasErrorCode(error, IdentityErrorCode.INVALID_CONFIG)) {
  console.log('Invalid config error');
}

// Create error with default message
const error = createError(IdentityErrorCode.INVALID_CONFIG);
```

## Types

The Identity Layer provides comprehensive TypeScript type definitions:

### Core Types

```typescript
import type {
  ProductIdentity,
  LegacyIdentity,
  BrandingConfig,
  ColorScheme,
  Typography,
  URLs,
  Legal,
} from '@titanium-claws/identity';
```

### Configuration Types

```typescript
import type {
  TitaniumClawsConfig,
  MigrationMetadata,
  PathOverrides,
  EnvironmentConfig,
  CompatibilityConfig,
  GatewayConfig,
  AgentsConfig,
  MemoryConfig,
  MonitoringConfig,
} from '@titanium-claws/identity';
```

### Path Types

```typescript
import type {
  ResolvedPaths,
  LegacyPaths,
} from '@titanium-claws/identity';
```

### Environment Types

```typescript
import type {
  ResolvedEnvironment,
  EnvironmentValidationResult,
} from '@titanium-claws/identity';
```

### Validation Types

```typescript
import type {
  ValidationResult,
  ValidationError,
} from '@titanium-claws/identity';
```

### Type Guards

```typescript
import type {
  Platform,
  AuthMode,
  LogFormat,
  MemoryBackend,
  VectorEngine,
  TextSearchEngine,
  CoordinationProtocol,
} from '@titanium-claws/identity';
```

## Constants

### Product Identity

```typescript
import { PRODUCT_IDENTITY } from '@titanium-claws/identity';
```

### Legacy Identity

```typescript
import { LEGACY_IDENTITY } from '@titanium-claws/identity';
```

### Environment Variables

```typescript
import {
  ENVIRONMENT_VARIABLES,
  LEGACY_ENVIRONMENT_VARIABLES,
} from '@titanium-claws/identity';

console.log(ENVIRONMENT_VARIABLES.STATE_DIR);       // "TITANIUM_CLAWS_STATE_DIR"
console.log(ENVIRONMENT_VARIABLES.GATEWAY_TOKEN);   // "TITANIUM_CLAWS_GATEWAY_TOKEN"
console.log(ENVIRONMENT_VARIABLES.LOG_LEVEL);       // "TITANIUM_CLAWS_LOG_LEVEL"
```

### Supported Platforms

```typescript
import { SUPPORTED_PLATFORMS } from '@titanium-claws/identity';

console.log(SUPPORTED_PLATFORMS);
// ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"]
```

### Supported Node.js Versions

```typescript
import { SUPPORTED_NODE_VERSIONS } from '@titanium-claws/identity';

console.log(SUPPORTED_NODE_VERSIONS.minimum);     // "22.0.0"
console.log(SUPPORTED_NODE_VERSIONS.recommended); // "22.16.0"
console.log(SUPPORTED_NODE_VERSIONS.maximum);     // "23.0.0"
```

### Feature Flags

```typescript
import { FEATURE_FLAGS } from '@titanium-claws/identity';

console.log(FEATURE_FLAGS.RUST_ENGINES);              // true
console.log(FEATURE_FLAGS.MULTI_AGENT);               // true
console.log(FEATURE_FLAGS.A2A_PROTOCOL);              // true
console.log(FEATURE_FLAGS.CAUSAL_GRAPH);              // true
console.log(FEATURE_FLAGS.BACKWARD_COMPATIBILITY);    // true
```

## Backward Compatibility

The Identity Layer maintains full backward compatibility with OpenClaw:

### Legacy Paths

- State directory: `~/.openclaw` → `~/.titanium-claws`
- Config file: `openclaw.json` → `titanium-claws.json`
- Database: `openclaw.sqlite` → `titanium-claws.sqlite`
- Logs: `openclaw.log` → `titanium-claws.log`

### Legacy Environment Variables

- `OPENCLAW_STATE_DIR` → `TITANIUM_CLAWS_STATE_DIR`
- `OPENCLAW_GATEWAY_TOKEN` → `TITANIUM_CLAWS_GATEWAY_TOKEN`
- `OPENCLAW_LOG_LEVEL` → `TITANIUM_CLAWS_LOG_LEVEL`

### Legacy Executable

- `openclaw` command → `tc` command

## Testing

Run tests with Vitest:

```bash
# Run all identity tests
pnpm test test/identity

# Run specific test file
pnpm test test/identity/constants.test.ts

# Run with coverage
pnpm test:coverage test/identity
```

## Examples

### Example 1: Product Information Display

```typescript
import { IdentityService } from '@titanium-claws/identity';

const service = new IdentityService();
const info = service.getProductInfo();
const branding = service.getBranding();

console.log(`
${info.displayName} v${info.version}
${info.tagline}

Website: ${info.urls.website}
Docs: ${info.urls.docs}
Repository: ${info.urls.repository}

Primary Color: ${branding.colors.primary}
Font: ${branding.typography.fontFamily}

${info.legal.copyright}
License: ${info.legal.license}
`);
```

### Example 2: Path Resolution

```typescript
import { PathResolver } from '@titanium-claws/identity';

const resolver = new PathResolver();

// Get all paths
const paths = resolver.resolve();

console.log('State Directory:', paths.stateDirectory);
console.log('Config File:', paths.configPath);
console.log('Database:', paths.databasePath);
console.log('Logs:', paths.logPath);
console.log('Cache:', paths.cachePath);
console.log('Temp:', paths.tempPath);
console.log('Plugins:', paths.pluginsPath);
console.log('Workspace:', paths.workspacePath);
```

### Example 3: Environment Configuration

```typescript
import { EnvironmentResolver } from '@titanium-claws/identity';

const resolver = new EnvironmentResolver();

// Resolve environment
const env = resolver.resolve();

// Validate
const validation = resolver.validate();

if (!validation.valid) {
  console.error('Environment validation failed:');
  validation.errors.forEach(error => {
    console.error(`  - ${error}`);
  });
  process.exit(1);
}

// Use environment variables
const gatewayToken = env.gatewayToken;
if (!gatewayToken) {
  console.error('Gateway token not configured');
  process.exit(1);
}
```

### Example 4: Error Handling

```typescript
import {
  IdentityService,
  IdentityError,
  IdentityErrorCode,
} from '@titanium-claws/identity';

const service = new IdentityService();

try {
  const config = service.loadConfig('invalid-path.json');
} catch (error) {
  if (error instanceof IdentityError) {
    switch (error.code) {
      case IdentityErrorCode.CONFIG_NOT_FOUND:
        console.error('Configuration file not found');
        break;
      case IdentityErrorCode.CONFIG_PARSE_ERROR:
        console.error('Failed to parse configuration');
        break;
      case IdentityErrorCode.INVALID_CONFIG:
        console.error('Invalid configuration format');
        break;
      default:
        console.error('Unknown error:', error.message);
    }
  } else {
    throw error;
  }
}
```

### Example 5: Type Checking

```typescript
import type { ProductIdentity } from '@titanium-claws/identity';
import { PRODUCT_IDENTITY } from '@titanium-claws/identity';

// TypeScript will ensure PRODUCT_IDENTITY matches ProductIdentity type
const identity: ProductIdentity = PRODUCT_IDENTITY;

// Type-safe access
console.log(identity.displayName);
console.log(identity.version);
console.log(identity.urls.website);
```

## Architecture

The Identity Layer is designed with the following principles:

### 1. Single Source of Truth

All identity information is defined in one place and referenced everywhere:

```
constants.ts
  ├── PRODUCT_IDENTITY (Titanium Claws)
  └── LEGACY_IDENTITY (OpenClaw)
```

### 2. Immutability

All constants are frozen to prevent accidental modification:

```typescript
export const PRODUCT_IDENTITY = Object.freeze({
  displayName: 'Titanium Claws',
  // ...
});
```

### 3. Type Safety

Full TypeScript type definitions ensure compile-time safety:

```typescript
interface ProductIdentity {
  readonly displayName: string;
  readonly version: string;
  // ...
}
```

### 4. Error Handling

Comprehensive error classes with error codes:

```typescript
export class IdentityError extends Error {
  constructor(
    message: string,
    public readonly code: IdentityErrorCode,
    public readonly cause?: Error,
  ) {
    super(message);
  }
}
```

### 5. Backward Compatibility

Automatic fallback to legacy paths and environment variables:

```typescript
resolveStateDirectory(): string {
  if (existsSync(newPath)) {
    return newPath;
  }
  if (existsSync(legacyPath)) {
    return legacyPath; // Fallback
  }
  return newPath; // Default
}
```

## Performance

The Identity Layer is optimized for performance:

- **Lazy Loading**: Constants are loaded only when accessed
- **Caching**: Resolved paths and environment variables are cached
- **Minimal Overhead**: Direct property access, no computation

## Security

The Identity Layer follows security best practices:

- **No Hardcoded Secrets**: Environment variables for sensitive data
- **Type Safety**: Compile-time validation of all inputs
- **Error Handling**: Comprehensive error reporting without information leakage

## Troubleshooting

### Issue: Path resolution returns legacy path

**Solution**: The new path doesn't exist yet. Create it manually or run migration.

```bash
mkdir -p ~/.titanium-claws
```

### Issue: Environment variables not recognized

**Solution**: Check for typos and ensure variables are exported:

```bash
export TITANIUM_CLAWS_GATEWAY_TOKEN=your-token
```

### Issue: Type errors in TypeScript

**Solution**: Ensure you're importing types correctly:

```typescript
import type { ProductIdentity } from '@titanium-claws/identity';
```

## API Reference

### Classes

- `IdentityService`: High-level identity management
- `PathResolver`: Filesystem path resolution
- `EnvironmentResolver`: Environment variable resolution
- `IdentityError`: Base error class
- `ConfigError`: Configuration errors
- `PathError`: Path errors
- `EnvironmentError`: Environment errors
- `ValidationError`: Validation errors
- `MigrationError`: Migration errors
- `CompatibilityError`: Compatibility errors
- `RuntimeError`: Runtime errors

### Functions

- `createError(code)`: Create error with default message
- `createConfigError(message)`: Create config error
- `createPathError(message)`: Create path error
- `createEnvironmentError(message)`: Create environment error
- `createValidationError(errors)`: Create validation error
- `createMigrationError(message)`: Create migration error
- `createCompatibilityError(message)`: Create compatibility error
- `createRuntimeError(message)`: Create runtime error
- `isIdentityError(error)`: Check if error is IdentityError
- `hasErrorCode(error, code)`: Check error code

### Constants

- `PRODUCT_IDENTITY`: Titanium Claws identity
- `LEGACY_IDENTITY`: OpenClaw identity
- `ENVIRONMENT_VARIABLES`: Environment variable mappings
- `LEGACY_ENVIRONMENT_VARIABLES`: Legacy environment variable mappings
- `SUPPORTED_PLATFORMS`: Supported platforms
- `SUPPORTED_NODE_VERSIONS`: Supported Node.js versions
- `FEATURE_FLAGS`: Feature flags

## Contributing

Contributions are welcome! Please read the contributing guide first.

## License

MIT License - see LICENSE file for details.

## Support

- **Documentation**: https://docs.titaniumclaws.ai
- **GitHub Issues**: https://github.com/titanium-claws/titanium-claws/issues
- **Discord**: https://discord.gg/titaniumclaws

---

**The Identity Layer is the foundation of Titanium Claws. 🦞⚡**
