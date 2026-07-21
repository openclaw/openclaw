# Identity Service

High-level API for accessing product identity information.

## Overview

The `IdentityService` provides convenient methods for retrieving product metadata, branding information, configuration details, and documentation URLs. It serves as the primary interface for accessing identity information throughout the Titanium Claws codebase.

## Installation

```typescript
import { IdentityService } from './identity-service.js';
// or
import { getIdentityService } from './identity-service.js';
```

## Usage

### Basic Usage

```typescript
import { IdentityService } from './identity-service.js';

const service = new IdentityService();

// Get product information
console.log(service.getDisplayName()); // "Titanium Claws"
console.log(service.getVersion());     // "1.0.0"
console.log(service.getTagline());     // "Rust-Powered Multi-Agent Intelligence"

// Get executable names
console.log(service.getExecutableName());        // "tc"
console.log(service.getExecutableName({ full: true })); // "titanium-claws"

// Get branding
const colors = service.getColorScheme();
console.log(colors.primary); // "#4A5568"

const typography = service.getTypography();
console.log(typography.fontFamily); // "Inter, system-ui, sans-serif"
```

### Singleton Pattern

For convenience, a singleton instance is available:

```typescript
import { getIdentityService } from './identity-service.js';

const service = getIdentityService();
console.log(service.getDisplayName()); // "Titanium Claws"
```

To reset the singleton (useful in tests):

```typescript
import { resetIdentityService } from './identity-service.js';

resetIdentityService();
```

## API Reference

### Constructor

#### `new IdentityService(options?: IdentityServiceOptions)`

Creates a new IdentityService instance.

**Parameters:**
- `options` (optional): Configuration options
  - `productIdentity`: Override product identity (useful for testing)
  - `legacyIdentity`: Override legacy identity (useful for testing)
  - `configPath`: Configuration file path

**Example:**
```typescript
const service = new IdentityService({
  productIdentity: { displayName: 'Custom Product' },
});
```

### Public Identity Methods

#### `getDisplayName(): string`

Returns the full product display name.

**Returns:** Product display name (e.g., "Titanium Claws")

#### `getShortName(): string`

Returns the short product name.

**Returns:** Short product name (e.g., "Titanium")

#### `getTagline(): string`

Returns the product tagline.

**Returns:** Product tagline (e.g., "Rust-Powered Multi-Agent Intelligence")

#### `getDescription(): string`

Returns the full product description.

**Returns:** Product description

### Technical Identity Methods

#### `getExecutableName(options?: { full?: boolean }): string`

Returns the CLI executable name.

**Parameters:**
- `options.full` (optional): If true, returns full name instead of short name

**Returns:** Executable name (e.g., "tc" or "titanium-claws")

**Example:**
```typescript
service.getExecutableName();        // "tc"
service.getExecutableName({ full: true }); // "titanium-claws"
```

#### `getPackageScope(): string`

Returns the NPM package scope.

**Returns:** Package scope (e.g., "@titanium-claws")

#### `getRepository(): string`

Returns the repository identifier.

**Returns:** Repository identifier (e.g., "titanium-claws/titanium-claws")

### Configuration Methods

#### `getStateDirectoryName(): string`

Returns the state directory name.

**Returns:** State directory name (e.g., ".titanium-claws")

#### `getConfigFileName(): string`

Returns the configuration file name.

**Returns:** Configuration file name (e.g., "titanium-claws.json")

#### `getEnvPrefix(): string`

Returns the environment variable prefix.

**Returns:** Environment variable prefix (e.g., "TITANIUM_CLAWS")

### Versioning Methods

#### `getVersion(): string`

Returns the product version.

**Returns:** Product version (e.g., "1.0.0")

#### `getOpenClawCompatibilityVersion(): string`

Returns the compatible OpenClaw version.

**Returns:** Compatible OpenClaw version (e.g., "2026.7.2")

#### `isCompatibleWithOpenClaw(version: string): boolean`

Checks compatibility with a specific OpenClaw version.

**Parameters:**
- `version`: OpenClaw version to check

**Returns:** `true` if compatible, `false` otherwise

**Example:**
```typescript
service.isCompatibleWithOpenClaw('2026.7.2');  // true
service.isCompatibleWithOpenClaw('2026.8.0');  // true
service.isCompatibleWithOpenClaw('2026.6.0');  // false
```

### Branding Methods

#### `getLogoPath(theme?: 'light' | 'dark'): string`

Returns the logo path for the specified theme.

**Parameters:**
- `theme` (optional): Theme ('light' or 'dark'). Defaults to 'light'

**Returns:** Logo path

**Example:**
```typescript
service.getLogoPath();       // "assets/logos/titanium-claws-light.svg"
service.getLogoPath('dark'); // "assets/logos/titanium-claws-dark.svg"
```

#### `getColorScheme(): ColorScheme`

Returns the complete color scheme.

**Returns:** Color scheme object

**Example:**
```typescript
const colors = service.getColorScheme();
console.log(colors.primary);   // "#4A5568"
console.log(colors.secondary); // "#2C5282"
console.log(colors.accent);    // "#E53E3E"
```

#### `getTypography(): Typography`

Returns the typography configuration.

**Returns:** Typography configuration object

**Example:**
```typescript
const typography = service.getTypography();
console.log(typography.fontFamily);      // "Inter, system-ui, sans-serif"
console.log(typography.fontFamilyMono);  // "JetBrains Mono, monospace"
```

### Documentation Methods

#### `getWebsiteUrl(): string`

Returns the main website URL.

**Returns:** Website URL (e.g., "https://titaniumclaws.ai")

#### `getDocsUrl(): string`

Returns the documentation site URL.

**Returns:** Documentation URL (e.g., "https://docs.titaniumclaws.ai")

#### `getRepositoryUrl(): string`

Returns the source code repository URL.

**Returns:** Repository URL (e.g., "https://github.com/titanium-claws/titanium-claws")

#### `getSupportEmail(): string`

Returns the support email address.

**Returns:** Support email (e.g., "mailto:support@titaniumclaws.ai")

### Legal Methods

#### `getLicense(): string`

Returns the license type.

**Returns:** License type (e.g., "MIT")

#### `getCopyright(): string`

Returns the copyright notice.

**Returns:** Copyright notice (e.g., "© 2026 Titanium Claws Contributors")

### Legacy Compatibility Methods

#### `getLegacyExecutableName(): string`

Returns the legacy OpenClaw executable name.

**Returns:** Legacy executable name (e.g., "openclaw")

#### `getLegacyPackageScope(): string`

Returns the legacy package scope.

**Returns:** Legacy package scope (e.g., "@openclaw")

#### `getLegacyStateDirectoryName(): string`

Returns the legacy state directory name.

**Returns:** Legacy state directory name (e.g., ".openclaw")

#### `getLegacyEnvPrefix(): string`

Returns the legacy environment variable prefix.

**Returns:** Legacy environment variable prefix (e.g., "OPENCLAW")

### Aggregate Methods

#### `getProductInfo(): ProductInfo`

Returns a summary of product information.

**Returns:** Product information object

**Example:**
```typescript
const info = service.getProductInfo();
console.log(info.displayName); // "Titanium Claws"
console.log(info.version);     // "1.0.0"
console.log(info.executable);  // "tc"
```

#### `getBranding(): BrandingConfig`

Returns the complete branding configuration.

**Returns:** Branding configuration object

#### `getUrls(): URLs`

Returns all documentation and support URLs.

**Returns:** URLs object

#### `getLegal(): Legal`

Returns all legal information.

**Returns:** Legal information object

#### `getIdentity(): ProductIdentity`

Returns the complete product identity.

**Returns:** Product identity object

#### `formatForDisplay(): string`

Returns a formatted string for display purposes.

**Returns:** Formatted identity string

**Example:**
```typescript
console.log(service.formatForDisplay());
// Output:
// Titanium Claws v1.0.0
// Rust-Powered Multi-Agent Intelligence
// 
// Executable: tc
// Package Scope: @titanium-claws
// State Directory: .titanium-claws
// Config File: titanium-claws.json
// 
// Website: https://titaniumclaws.ai
// Documentation: https://docs.titaniumclaws.ai
// Repository: https://github.com/titanium-claws/titanium-claws
// 
// © 2026 Titanium Claws Contributors
// License: MIT
```

#### `exportAsJson(): string`

Returns the identity as a JSON string.

**Returns:** JSON string

#### `validate(): { valid: boolean; errors: string[] }`

Validates the identity configuration.

**Returns:** Validation result with valid flag and error messages

**Example:**
```typescript
const result = service.validate();
if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

## Types

### `IdentityServiceOptions`

Configuration options for IdentityService.

```typescript
interface IdentityServiceOptions {
  productIdentity?: Partial<ProductIdentity>;
  legacyIdentity?: Partial<LegacyIdentity>;
  configPath?: string;
}
```

### `ProductInfo`

Product information summary.

```typescript
interface ProductInfo {
  displayName: string;
  shortName: string;
  version: string;
  tagline: string;
  description: string;
  executable: string;
  packageScope: string;
  repository: string;
  stateDirectory: string;
  configFile: string;
}
```

## Error Handling

The IdentityService may throw the following errors:

- `RuntimeError` with code `IDENTITY_NOT_INITIALIZED`: Service not initialized
- `ConfigError` with code `CONFIG_NOT_FOUND`: Configuration file not found
- `ConfigError` with code `CONFIG_PARSE_ERROR`: Failed to parse configuration

**Example:**
```typescript
try {
  const config = await service.loadConfig('config.json');
} catch (error) {
  if (error instanceof IdentityError) {
    console.error('Error:', error.message);
    console.error('Code:', error.code);
  }
}
```

## Best Practices

### 1. Use Singleton for Convenience

For most use cases, the singleton pattern is recommended:

```typescript
import { getIdentityService } from './identity-service.js';

const service = getIdentityService();
```

### 2. Override for Testing

When testing, create custom instances with overrides:

```typescript
const testService = new IdentityService({
  productIdentity: { displayName: 'Test Product' },
});
```

### 3. Validate Before Use

Always validate the identity configuration:

```typescript
const result = service.validate();
if (!result.valid) {
  throw new Error(`Invalid identity: ${result.errors.join(', ')}`);
}
```

### 4. Use Type-Safe Methods

Prefer specific methods over accessing the identity object directly:

```typescript
// Good
const version = service.getVersion();

// Avoid
const identity = service.getIdentity();
const version = identity.version;
```

## Examples

### Display Product Information

```typescript
import { getIdentityService } from './identity-service.js';

const service = getIdentityService();

console.log(`
${service.getDisplayName()} v${service.getVersion()}
${service.getTagline()}

Executable: ${service.getExecutableName()}
Website: ${service.getWebsiteUrl()}
Documentation: ${service.getDocsUrl()}

${service.getCopyright()}
License: ${service.getLicense()}
`);
```

### Check OpenClaw Compatibility

```typescript
import { getIdentityService } from './identity-service.js';

const service = getIdentityService();
const openclawVersion = '2026.8.0';

if (service.isCompatibleWithOpenClaw(openclawVersion)) {
  console.log('✓ Compatible with OpenClaw', openclawVersion);
} else {
  console.log('✗ Incompatible with OpenClaw', openclawVersion);
}
```

### Get Branding Information

```typescript
import { getIdentityService } from './identity-service.js';

const service = getIdentityService();

const colors = service.getColorScheme();
console.log('Primary Color:', colors.primary);
console.log('Accent Color:', colors.accent);

const typography = service.getTypography();
console.log('Font Family:', typography.fontFamily);
console.log('Mono Font:', typography.fontFamilyMono);
```

### Validate Configuration

```typescript
import { getIdentityService } from './identity-service.js';

const service = getIdentityService();

const validation = service.validate();
if (!validation.valid) {
  console.error('Validation errors:');
  validation.errors.forEach(error => {
    console.error(`  - ${error}`);
  });
  process.exit(1);
}

console.log('✓ Configuration is valid');
```

## Migration from Constants

If you were previously using constants directly, migrate to the service:

```typescript
// Before
import { PRODUCT_IDENTITY } from './constants.js';
console.log(PRODUCT_IDENTITY.displayName);

// After
import { getIdentityService } from './identity-service.js';
const service = getIdentityService();
console.log(service.getDisplayName());
```

## Testing

```typescript
import { describe, it, expect } from 'vitest';
import { IdentityService } from './identity-service.js';

describe('MyComponent', () => {
  it('should display product name', () => {
    const service = new IdentityService({
      productIdentity: { displayName: 'Test Product' },
    });
    
    expect(service.getDisplayName()).toBe('Test Product');
  });
});
```

## Performance

The IdentityService is optimized for performance:

- **Lazy Initialization**: Service is initialized only when first accessed
- **Caching**: Identity object is cached for fast access
- **Immutability**: Returned objects are copies, not references
- **No Side Effects**: Methods are pure functions

## Security

The IdentityService follows security best practices:

- **No Hardcoded Secrets**: All sensitive data comes from environment
- **Type Safety**: Full TypeScript type checking
- **Validation**: All inputs are validated
- **Immutability**: Identity object cannot be modified at runtime

## Troubleshooting

### Issue: "Identity service not initialized"

**Solution**: Create a new instance or use the singleton:

```typescript
const service = new IdentityService();
// or
const service = getIdentityService();
```

### Issue: "Configuration file not found"

**Solution**: Ensure the configuration file exists:

```typescript
const service = new IdentityService({
  configPath: '/path/to/config.json',
});
```

### Issue: "Invalid version format"

**Solution**: Use semantic versioning format:

```typescript
const service = new IdentityService({
  productIdentity: { version: '1.0.0' },
});
```

## Related Documentation

- [Constants](./constants.ts) - Product identity constants
- [Types](./types.ts) - TypeScript type definitions
- [Errors](./errors.ts) - Error classes and codes

## License

MIT License - see LICENSE file for details.

## Support

- **Documentation**: https://docs.titaniumclaws.ai
- **GitHub Issues**: https://github.com/titanium-claws/titanium-claws/issues
- **Discord**: https://discord.gg/titaniumclaws

---

**The Identity Service is the high-level API for product identity. 🦞⚡**
