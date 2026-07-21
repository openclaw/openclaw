# PathResolver Documentation

Comprehensive path resolution system with backward compatibility support for Titanium Claws.

## Overview

The `PathResolver` class provides a centralized way to resolve all filesystem paths used by Titanium Claws. It supports backward compatibility with OpenClaw paths, environment variable overrides, and path validation.

## Installation

```typescript
import { PathResolver, getPathResolver } from '@titaniumclaws/identity';
```

## Usage

### Basic Usage

```typescript
import { PathResolver } from '@titaniumclaws/identity';

const resolver = new PathResolver();

// Resolve individual paths
const stateDir = resolver.resolveStateDirectory();
const configPath = resolver.resolveConfigPath();
const dbPath = resolver.resolveDatabasePath();
const logPath = resolver.resolveLogPath();

// Resolve all paths at once
const paths = resolver.resolveAll();
console.log(paths.stateDirectory);
console.log(paths.configPath);
```

### Singleton Pattern

For convenience, use the singleton pattern:

```typescript
import { getPathResolver } from '@titaniumclaws/identity';

const resolver = getPathResolver();
const stateDir = resolver.resolveStateDirectory();
```

### Custom Options

```typescript
const resolver = new PathResolver({
  homeDir: '/custom/home',
  validatePaths: true,
  createDirectories: true,
});
```

## API Reference

### Constructor

#### `new PathResolver(options?: PathResolverOptions)`

Creates a new PathResolver instance.

**Options:**
- `homeDir`: Custom home directory (defaults to OS home directory)
- `validatePaths`: Validate paths exist (defaults to false)
- `createDirectories`: Create directories if they don't exist (defaults to false)

### Path Resolution Methods

#### `resolveStateDirectory(): string`

Resolves the state directory path.

**Resolution Order:**
1. Environment variable `TITANIUM_CLAWS_STATE_DIR`
2. New path `~/.titanium-claws`
3. Legacy path `~/.openclaw`

**Example:**
```typescript
const stateDir = resolver.resolveStateDirectory();
// Returns: "/home/user/.titanium-claws"
```

#### `resolveConfigPath(): string`

Resolves the configuration file path.

**Resolution Order:**
1. Environment variable `TITANIUM_CLAWS_CONFIG_PATH`
2. State directory + `titanium-claws.json`

**Example:**
```typescript
const configPath = resolver.resolveConfigPath();
// Returns: "/home/user/.titanium-claws/titanium-claws.json"
```

#### `resolveDatabasePath(): string`

Resolves the database file path.

**Resolution:**
- State directory + `titanium-claws.sqlite`

**Example:**
```typescript
const dbPath = resolver.resolveDatabasePath();
// Returns: "/home/user/.titanium-claws/titanium-claws.sqlite"
```

#### `resolveLogPath(): string`

Resolves the log file path.

**Resolution:**
- State directory + `logs/titanium-claws.log`

**Example:**
```typescript
const logPath = resolver.resolveLogPath();
// Returns: "/home/user/.titanium-claws/logs/titanium-claws.log"
```

#### `resolveCachePath(): string`

Resolves the cache directory path.

**Resolution:**
- State directory + `cache`

**Example:**
```typescript
const cachePath = resolver.resolveCachePath();
// Returns: "/home/user/.titanium-claws/cache"
```

#### `resolveTempPath(): string`

Resolves the temporary directory path.

**Resolution:**
- State directory + `temp`

**Example:**
```typescript
const tempPath = resolver.resolveTempPath();
// Returns: "/home/user/.titanium-claws/temp"
```

#### `resolvePluginsPath(): string`

Resolves the plugins directory path.

**Resolution:**
- State directory + `plugins`

**Example:**
```typescript
const pluginsPath = resolver.resolvePluginsPath();
// Returns: "/home/user/.titanium-claws/plugins"
```

#### `resolveWorkspacePath(): string`

Resolves the workspace directory path.

**Resolution:**
- State directory + `workspace`

**Example:**
```typescript
const workspacePath = resolver.resolveWorkspacePath();
// Returns: "/home/user/.titanium-claws/workspace"
```

#### `resolveAll(): ResolvedPaths`

Resolves all paths at once.

**Returns:**
```typescript
interface ResolvedPaths {
  stateDirectory: string;
  configPath: string;
  databasePath: string;
  logPath: string;
  cachePath: string;
  tempPath: string;
  pluginsPath: string;
  workspacePath: string;
}
```

**Example:**
```typescript
const paths = resolver.resolveAll();
console.log(paths.stateDirectory);
console.log(paths.configPath);
```

### Legacy Path Methods

#### `getLegacyPaths(): LegacyPaths`

Gets all legacy OpenClaw paths.

**Returns:**
```typescript
interface LegacyPaths {
  stateDirectory: string;
  configPath: string;
  databasePath: string;
  logPath: string;
}
```

**Example:**
```typescript
const legacyPaths = resolver.getLegacyPaths();
console.log(legacyPaths.stateDirectory);
// Returns: "/home/user/.openclaw"
```

#### `isUsingLegacyPaths(): boolean`

Checks if using legacy OpenClaw paths.

**Example:**
```typescript
const isLegacy = resolver.isUsingLegacyPaths();
if (isLegacy) {
  console.log('Using legacy OpenClaw paths');
}
```

### Directory Management

#### `async ensureDirectories(): Promise<void>`

Ensures all required directories exist. Creates them if they don't exist.

**Example:**
```typescript
await resolver.ensureDirectories();
// Creates state directory, cache, temp, plugins, workspace directories
```

### Validation

#### `validate(): { valid: boolean; errors: string[] }`

Validates all resolved paths.

**Example:**
```typescript
const result = resolver.validate();
if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

### Cache Management

#### `clearCache(): void`

Clears the path cache.

**Example:**
```typescript
resolver.clearCache();
```

#### `getCache(): Map<string, string>`

Gets a copy of the path cache.

**Example:**
```typescript
const cache = resolver.getCache();
console.log(cache.get('stateDirectory'));
```

### Path Details

#### `getPathDetails(pathType: keyof ResolvedPaths): PathResolutionResult`

Gets detailed information about a specific path.

**Returns:**
```typescript
interface PathResolutionResult {
  path: string;
  exists: boolean;
  isLegacy: boolean;
}
```

**Example:**
```typescript
const details = resolver.getPathDetails('stateDirectory');
console.log(details.path);
console.log(details.exists);
console.log(details.isLegacy);
```

### Formatting and Export

#### `formatForDisplay(): string`

Formats all paths for display.

**Example:**
```typescript
console.log(resolver.formatForDisplay());
// Output:
// State Directory: /home/user/.titanium-claws
// Config File: /home/user/.titanium-claws/titanium-claws.json
// ...
```

#### `exportAsJson(): string`

Exports all paths as JSON.

**Example:**
```typescript
const json = resolver.exportAsJson();
console.log(json);
// Output: {"stateDirectory":"/home/user/.titanium-claws",...}
```

### Singleton Methods

#### `static getInstance(): PathResolver`

Gets the singleton instance.

**Example:**
```typescript
const resolver = PathResolver.getInstance();
```

#### `static resetInstance(): void`

Resets the singleton instance (for testing).

**Example:**
```typescript
PathResolver.resetInstance();
```

## Environment Variables

### Path Overrides

The following environment variables can override default paths:

- `TITANIUM_CLAWS_STATE_DIR`: Override state directory
- `TITANIUM_CLAWS_CONFIG_PATH`: Override config file path

**Example:**
```bash
export TITANIUM_CLAWS_STATE_DIR=/custom/state/dir
```

### Path Expansion

The resolver supports path expansion:

- `~`: Expands to home directory
- `$HOME`: Expands to home directory

**Example:**
```bash
export TITANIUM_CLAWS_STATE_DIR=~/custom/state
```

## Backward Compatibility

The PathResolver automatically falls back to legacy OpenClaw paths:

**Resolution Order:**
1. Environment variable (if set)
2. New Titanium Claws path (`~/.titanium-claws`)
3. Legacy OpenClaw path (`~/.openclaw`)

**Example:**
```typescript
// If ~/.titanium-claws doesn't exist but ~/.openclaw does
const stateDir = resolver.resolveStateDirectory();
// Returns: "/home/user/.openclaw"
```

## Examples

### Basic Usage

```typescript
import { PathResolver } from '@titaniumclaws/identity';

const resolver = new PathResolver();

// Get all paths
const paths = resolver.resolveAll();

console.log('State Directory:', paths.stateDirectory);
console.log('Config File:', paths.configPath);
console.log('Database:', paths.databasePath);
```

### With Custom Options

```typescript
const resolver = new PathResolver({
  homeDir: '/custom/home',
  validatePaths: true,
  createDirectories: true,
});

// Ensure directories exist
await resolver.ensureDirectories();

// Validate paths
const validation = resolver.validate();
if (!validation.valid) {
  console.error('Invalid paths:', validation.errors);
}
```

### Check Legacy Usage

```typescript
const resolver = new PathResolver();

if (resolver.isUsingLegacyPaths()) {
  console.log('Using legacy OpenClaw paths');
  console.log('Consider migrating to Titanium Claws paths');
  
  const legacyPaths = resolver.getLegacyPaths();
  console.log('Legacy state directory:', legacyPaths.stateDirectory);
}
```

### Path Details

```typescript
const resolver = new PathResolver();

const details = resolver.getPathDetails('stateDirectory');

console.log('Path:', details.path);
console.log('Exists:', details.exists);
console.log('Is Legacy:', details.isLegacy);
```

### Export Paths

```typescript
const resolver = new PathResolver();

// Export as JSON
const json = resolver.exportAsJson();
fs.writeFileSync('paths.json', json);

// Format for display
console.log(resolver.formatForDisplay());
```

## Error Handling

The PathResolver throws the following errors:

### `PathError`

Thrown when path resolution fails.

**Example:**
```typescript
try {
  await resolver.ensureDirectories();
} catch (error) {
  if (error instanceof PathError) {
    console.error('Path error:', error.message);
    console.error('Error code:', error.code);
  }
}
```

### Error Codes

- `PATH_NOT_FOUND`: Path does not exist
- `DIRECTORY_CREATION_FAILED`: Failed to create directory
- `PERMISSION_DENIED`: Permission denied

## Best Practices

### 1. Use Singleton for Convenience

```typescript
import { getPathResolver } from '@titaniumclaws/identity';

const resolver = getPathResolver();
```

### 2. Validate Paths Before Use

```typescript
const validation = resolver.validate();
if (!validation.valid) {
  throw new Error(`Invalid paths: ${validation.errors.join(', ')}`);
}
```

### 3. Ensure Directories Exist

```typescript
await resolver.ensureDirectories();
```

### 4. Check for Legacy Paths

```typescript
if (resolver.isUsingLegacyPaths()) {
  console.warn('Using legacy paths. Consider migrating.');
}
```

### 5. Clear Cache After Configuration Changes

```typescript
// After changing environment variables
resolver.clearCache();
```

## Performance

The PathResolver is optimized for performance:

- **Caching**: Resolved paths are cached for fast access
- **Lazy Evaluation**: Paths are resolved only when requested
- **Efficient Resolution**: Minimal filesystem operations

## Security

The PathResolver follows security best practices:

- **Path Validation**: Validates paths before use
- **Permission Checks**: Checks file permissions
- **No Path Traversal**: Prevents path traversal attacks
- **Environment Variable Sanitization**: Sanitizes environment variables

## Testing

### Reset Singleton in Tests

```typescript
import { resetPathResolver } from '@titaniumclaws/identity';

beforeEach(() => {
  resetPathResolver();
});
```

### Mock Environment Variables

```typescript
const originalEnv = process.env.TITANIUM_CLAWS_STATE_DIR;

beforeAll(() => {
  process.env.TITANIUM_CLAWS_STATE_DIR = '/test/path';
});

afterAll(() => {
  process.env.TITANIUM_CLAWS_STATE_DIR = originalEnv;
});
```

## Migration from OpenClaw

### Automatic Migration

The PathResolver automatically handles migration:

```typescript
const resolver = new PathResolver();

// If using legacy paths, consider migrating
if (resolver.isUsingLegacyPaths()) {
  const legacyPaths = resolver.getLegacyPaths();
  const newPaths = resolver.resolveAll();
  
  // Migrate data from legacy to new paths
  // ...
}
```

### Manual Migration

```typescript
const resolver = new PathResolver({
  homeDir: os.homedir(),
  createDirectories: true,
});

// Create new directories
await resolver.ensureDirectories();

// Migrate configuration
const legacyConfig = resolver.getLegacyPaths().configPath;
const newConfig = resolver.resolveConfigPath();

// Copy configuration
fs.copyFileSync(legacyConfig, newConfig);
```

## Troubleshooting

### Issue: Paths not resolving correctly

**Solution:**
```typescript
// Clear cache
resolver.clearCache();

// Check environment variables
console.log(process.env.TITANIUM_CLAWS_STATE_DIR);

// Re-resolve paths
const paths = resolver.resolveAll();
```

### Issue: Directories not being created

**Solution:**
```typescript
const resolver = new PathResolver({
  createDirectories: true,
});

await resolver.ensureDirectories();
```

### Issue: Legacy paths not detected

**Solution:**
```typescript
const legacyPaths = resolver.getLegacyPaths();
console.log('Legacy state directory:', legacyPaths.stateDirectory);

// Check if directory exists
const exists = fs.existsSync(legacyPaths.stateDirectory);
console.log('Legacy directory exists:', exists);
```

## Related Documentation

- [IdentityService](./identity-service.md) - High-level identity API
- [Constants](./constants.md) - Product identity constants
- [Types](./types.md) - TypeScript type definitions
- [Errors](./errors.md) - Error classes and codes

## License

MIT License - see LICENSE file for details.

## Support

- **Documentation**: https://docs.titaniumclaws.ai
- **GitHub Issues**: https://github.com/titaniumclaws/titaniumclaws/issues
- **Discord**: https://discord.gg/titaniumclaws

---

**The PathResolver provides centralized path management with backward compatibility. 🦞⚡**
