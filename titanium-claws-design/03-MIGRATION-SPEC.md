# Titanium Claws Migration Specification

**Status**: Draft  
**Created**: 2026-07-21  
**Version**: 1.0.0  
**RFC**: See `01-ARCHITECTURE-RFC.md`  
**Identity Layer**: See `02-IDENTITY-LAYER-SPEC.md`

---

## Executive Summary

This specification defines the **Migration Specification** for transitioning from OpenClaw to Titanium Claws. The migration follows a phased, workstream-based approach that minimizes risk, maintains backward compatibility, and allows for incremental validation at each stage.

### Migration Philosophy

1. **Phased Approach**: Execute migration in independent, reviewable stages
2. **Zero Disruption**: Existing OpenClaw deployments continue working
3. **Automated Where Possible**: Use AST-aware codemods, not blind find-replace
4. **Validated at Each Stage**: Comprehensive testing before proceeding
5. **Rollback Ready**: Each phase can be reversed if issues arise

---

## 1. Migration Overview

### 1.1 Migration Scope

| Category | Scope | Risk | Priority |
|----------|-------|------|----------|
| **Public Identity** | Repository, docs, branding | Low | P0 |
| **CLI & Executable** | Command name, help text | Low | P0 |
| **Configuration** | Paths, state directory | Medium | P1 |
| **Environment** | Variables, prefixes | Medium | P1 |
| **NPM Packages** | Package names, imports | Medium | P2 |
| **Native Apps** | Bundle IDs, manifests | High | P3 |
| **Internal Code** | Namespaces, protocols | Low | P4 |
| **Database** | Schema, migrations | High | P4 |

### 1.2 Migration Timeline

```
Week 1-2:   Phase 1 - Branding & Documentation
Week 3-4:   Phase 2 - CLI & Executable
Week 5-6:   Phase 3 - Configuration & Paths
Week 7-8:   Phase 4 - Environment Variables
Week 9-10:  Phase 5 - NPM Packages & Imports
Week 11-12: Phase 6 - Native Apps & Bundle IDs
Week 13-14: Phase 7 - Internal Namespaces (Optional)
Week 15-16: Phase 8 - Final Validation & Launch
```

**Total Duration**: 16 weeks (4 months)  
**Team Size**: 3-4 developers  
**Estimated Effort**: 640-850 developer-hours

### 1.3 Success Criteria

| Phase | Success Metric | Validation Method |
|-------|---------------|-------------------|
| **Phase 1** | Documentation updated, logos replaced | Manual review, link checks |
| **Phase 2** | CLI executable renamed, help text updated | Functional testing |
| **Phase 3** | Config paths resolved correctly | Integration tests |
| **Phase 4** | Environment variables work (new + legacy) | Environment tests |
| **Phase 5** | Packages importable with new scope | Build tests |
| **Phase 6** | Native apps build and install | Device testing |
| **Phase 7** | Internal namespaces updated (if chosen) | Code review |
| **Phase 8** | All tests pass, zero regressions | CI/CD pipeline |

---

## 2. Workstream Architecture

### 2.1 Workstream Dependencies

```
┌─────────────────────────────────────────────────────────┐
│                    Workstream Graph                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Branding ───────► CLI ───────► Configuration            │
│     │                │               │                   │
│     │                │               ▼                   │
│     │                │         Environment               │
│     │                │               │                   │
│     ▼                ▼               ▼                   │
│   Native Apps ◄─── Packages ◄── Internal (Optional)     │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Workstream Definitions

| Workstream | Description | Dependencies | Estimated Effort |
|------------|-------------|--------------|------------------|
| **WS1: Branding** | Repository, docs, logos, website | None | 40 hours |
| **WS2: CLI** | Executable name, help text, installers | WS1 | 60 hours |
| **WS3: Configuration** | Paths, state directory, config files | WS2 | 80 hours |
| **WS4: Environment** | Variables, prefixes, dual resolution | WS3 | 60 hours |
| **WS5: Packages** | NPM scope, imports, dependencies | WS2 | 100 hours |
| **WS6: Native Apps** | Bundle IDs, manifests, signing | WS1 | 120 hours |
| **WS7: Internal** | Namespaces, protocols, schemas | WS5 | 80 hours |
| **WS8: Validation** | Testing, documentation, launch | All | 120 hours |

### 2.3 Parallel Execution

Workstreams can run in parallel where dependencies allow:

**Week 1-2 (Parallel)**:
- WS1: Branding (Documentation team)
- WS2: CLI (CLI team)
- WS5: Packages (Infrastructure team)

**Week 3-4 (Parallel)**:
- WS3: Configuration (Core team)
- WS4: Environment (Core team)
- WS6: Native Apps (Mobile team)

**Week 5-6 (Sequential)**:
- WS7: Internal (Optional, Core team)
- WS8: Validation (All teams)

---

## 3. Phase 1: Branding & Documentation

### 3.1 Scope

| Component | Current | Target | Automation |
|-----------|---------|--------|------------|
| **Repository Name** | `openclaw` | `titanium-claws` | Manual |
| **README.md** | "OpenClaw" | "Titanium Claws" | Semi-automated |
| **VISION.md** | "OpenClaw" | "Titanium Claws" | Semi-automated |
| **AGENTS.md** | "OpenClaw" | "Titanium Claws" | Semi-automated |
| **docs/** | "OpenClaw" | "Titanium Claws" | Semi-automated |
| **Logos** | `openclaw-logo.svg` | `titanium-claws-logo.svg` | Manual |
| **Website** | `openclaw.ai` | `titaniumclaws.ai` | Manual |
| **Package.json** | `"name": "openclaw"` | `"name": "titanium-claws"` | Automated |

### 3.2 Execution Plan

**Step 1: Repository Renaming**
```bash
# GitHub repository settings
# Settings → Repository name → Change to "titanium-claws"
# Note: GitHub will automatically redirect old URLs
```

**Step 2: Documentation Update**
```bash
# Semi-automated update using AST-aware tooling
node scripts/migrate-docs.js \
  --source "OpenClaw" \
  --target "Titanium Claws" \
  --files "README.md,VISION.md,AGENTS.md,docs/**/*.md"
```

**Step 3: Logo Replacement**
```bash
# Manual design work
# Replace all logo files with Titanium Claws branding
cp logos/titanium-claws-*.svg assets/logos/
```

**Step 4: Package Metadata**
```json
{
  "name": "titanium-claws",
  "version": "1.0.0",
  "description": "Rust-Powered Multi-Agent Intelligence",
  "homepage": "https://titaniumclaws.ai",
  "repository": {
    "type": "git",
    "url": "https://github.com/titanium-claws/titanium-claws.git"
  },
  "bugs": {
    "url": "https://github.com/titanium-claws/titanium-claws/issues"
  }
}
```

### 3.3 Validation Checklist

- [ ] Repository name updated on GitHub
- [ ] Old repository URL redirects to new URL
- [ ] README.md references Titanium Claws
- [ ] All documentation updated
- [ ] Logos replaced in all locations
- [ ] Website content updated
- [ ] Package.json metadata updated
- [ ] License headers updated (if applicable)
- [ ] Copyright notices updated

### 3.4 Rollback Plan

```bash
# Revert repository name
# GitHub Settings → Repository name → Change back to "openclaw"

# Revert documentation
git checkout HEAD~1 -- README.md VISION.md AGENTS.md docs/

# Revert package.json
git checkout HEAD~1 -- package.json
```

---

## 4. Phase 2: CLI & Executable

### 4.1 Scope

| Component | Current | Target | Automation |
|-----------|---------|--------|------------|
| **Binary Name** | `openclaw` | `tc` | Automated |
| **Entry Point** | `openclaw.mjs` | `titanium-claws.mjs` | Automated |
| **Help Text** | "OpenClaw" | "Titanium Claws" | Semi-automated |
| **Installers** | `install-openclaw.sh` | `install-titanium-claws.sh` | Semi-automated |
| **Man Pages** | `openclaw.1` | `tc.1` | Automated |
| **Shell Completion** | `openclaw-completion.bash` | `tc-completion.bash` | Automated |

### 4.2 Execution Plan

**Step 1: Entry Point Renaming**
```bash
# Rename entry point file
mv openclaw.mjs titanium-claws.mjs

# Update package.json bin field
```

```json
{
  "bin": {
    "tc": "titanium-claws.mjs",
    "titanium-claws": "titanium-claws.mjs",
    "openclaw": "titanium-claws.mjs"  // Backward compatibility
  }
}
```

**Step 2: CLI Help Text Update**
```typescript
// src/cli/help.ts
import { IdentityService } from "@titanium-claws/identity"

const identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)

export function showHelp() {
  console.log(`
${identity.getDisplayName()} v${identity.getVersion()}
${identity.getTagline()}

Usage: ${identity.getExecutableName()} <command> [options]

Commands:
  gateway      Start the gateway server
  agent        Manage AI agents
  workflow     Manage workflows
  doctor       Run diagnostics
  migrate      Migrate from OpenClaw

Options:
  --version    Show version number
  --help       Show help

Documentation: ${identity.getDocsUrl()}
Repository: ${identity.getRepositoryUrl()}
Support: ${identity.getSupportEmail()}
  `.trim())
}
```

**Step 3: Installer Scripts**
```bash
#!/bin/bash
# install-titanium-claws.sh

set -euo pipefail

echo "Installing Titanium Claws..."

# Detect platform
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  PLATFORM="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  PLATFORM="macos"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
  PLATFORM="windows"
else
  echo "Unsupported platform: $OSTYPE"
  exit 1
fi

# Download binary
curl -L "https://github.com/titanium-claws/titanium-claws/releases/latest/download/tc-$PLATFORM" -o tc
chmod +x tc

# Install to /usr/local/bin
sudo mv tc /usr/local/bin/tc

echo "Titanium Claws installed successfully!"
echo "Run 'tc --help' to get started"
```

**Step 4: Shell Completion**
```bash
# tc-completion.bash

_tc() {
  local cur prev opts
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  opts="gateway agent workflow doctor migrate --version --help"
  
  if [[ ${cur} == -* ]] ; then
    COMPREPLY=( $(compgen -W "--version --help" -- ${cur}) )
    return 0
  fi
  
  COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
  return 0
}

complete -F _tc tc
```

### 4.3 Validation Checklist

- [ ] Binary renamed to `tc`
- [ ] `tc --version` shows correct version
- [ ] `tc --help` shows updated help text
- [ ] `tc gateway` starts gateway
- [ ] `tc doctor` runs diagnostics
- [ ] Installer script works on Linux, macOS, Windows
- [ ] Shell completion works
- [ ] Man pages installed correctly
- [ ] Backward compatibility: `openclaw` command still works (symlink)

### 4.4 Rollback Plan

```bash
# Revert binary name
git checkout HEAD~1 -- openclaw.mjs

# Revert package.json
git checkout HEAD~1 -- package.json

# Revert help text
git checkout HEAD~1 -- src/cli/help.ts
```

---

## 5. Phase 3: Configuration & Paths

### 5.1 Scope

| Component | Current | Target | Automation |
|-----------|---------|--------|------------|
| **State Directory** | `~/.openclaw` | `~/.titanium-claws` | Automated |
| **Config File** | `openclaw.json` | `titanium-claws.json` | Automated |
| **Database** | `openclaw.sqlite` | `titanium-claws.sqlite` | Automated |
| **Logs** | `openclaw.log` | `titanium-claws.log` | Automated |
| **Cache** | `~/.openclaw/cache` | `~/.titanium-claws/cache` | Automated |

### 5.2 Execution Plan

**Step 1: Path Resolver Implementation**
```typescript
// src/identity/path-resolver.ts
// See 02-IDENTITY-LAYER-SPEC.md for full implementation

export class PathResolver {
  resolveStateDirectory(): string {
    const envPath = process.env.TITANIUM_CLAWS_STATE_DIR
    if (envPath) {
      return envPath
    }
    
    const homeDir = os.homedir()
    const newPath = path.join(homeDir, ".titanium-claws")
    
    if (fs.existsSync(newPath)) {
      return newPath
    }
    
    // Legacy fallback
    const legacyPath = path.join(homeDir, ".openclaw")
    if (fs.existsSync(legacyPath)) {
      return legacyPath
    }
    
    return newPath
  }
  
  resolveConfigPath(): string {
    const envPath = process.env.TITANIUM_CLAWS_CONFIG_PATH
    if (envPath) {
      return envPath
    }
    
    const stateDir = this.resolveStateDirectory()
    const newPath = path.join(stateDir, "titanium-claws.json")
    
    if (fs.existsSync(newPath)) {
      return newPath
    }
    
    const legacyPath = path.join(stateDir, "openclaw.json")
    if (fs.existsSync(legacyPath)) {
      return legacyPath
    }
    
    return newPath
  }
}
```

**Step 2: Migration Tool**
```typescript
// src/migration/state-migration.ts

export class StateMigration {
  async migrateFromOpenClaw(): Promise<MigrationResult> {
    const legacyStateDir = path.join(os.homedir(), ".openclaw")
    const newStateDir = path.join(os.homedir(), ".titanium-claws")
    
    // Check if legacy exists
    if (!fs.existsSync(legacyStateDir)) {
      return { status: "no_migration_needed" }
    }
    
    // Check if new already exists
    if (fs.existsSync(newStateDir)) {
      return { status: "already_migrated" }
    }
    
    // Create backup
    const backupDir = path.join(
      os.homedir(),
      ".titanium-claws-backup-" + Date.now()
    )
    await fs.promises.cp(legacyStateDir, backupDir, { recursive: true })
    
    // Create symlink for backward compatibility
    await fs.promises.symlink(legacyStateDir, newStateDir)
    
    return {
      status: "migration_success",
      backupPath: backupDir,
      symlinkCreated: true
    }
  }
  
  async rollback(backupPath: string): Promise<void> {
    const newStateDir = path.join(os.homedir(), ".titanium-claws")
    
    // Remove symlink
    await fs.promises.unlink(newStateDir)
    
    // Restore from backup
    await fs.promises.cp(backupPath, newStateDir, { recursive: true })
  }
}
```

**Step 3: Configuration Migration**
```typescript
// src/migration/config-migration.ts

export class ConfigMigration {
  async migrateConfig(legacyPath: string, newPath: string): Promise<void> {
    // Load legacy config
    const config = JSON.parse(
      await fs.promises.readFile(legacyPath, "utf-8")
    )
    
    // Add migration metadata
    config._migration = {
      from: "openclaw",
      to: "titanium-claws",
      migratedAt: new Date().toISOString(),
      version: "1.0.0"
    }
    
    // Save to new location
    await fs.promises.writeFile(
      newPath,
      JSON.stringify(config, null, 2)
    )
    
    // Rename legacy file
    const backupPath = legacyPath + ".migrated"
    await fs.promises.rename(legacyPath, backupPath)
  }
}
```

### 5.3 Validation Checklist

- [ ] Path resolver works with new paths
- [ ] Path resolver falls back to legacy paths
- [ ] Migration tool creates symlink correctly
- [ ] Configuration migration preserves all settings
- [ ] Database migration works (if schema changes)
- [ ] Logs written to new location
- [ ] Cache directory created correctly
- [ ] Backward compatibility: old paths still work
- [ ] Migration can be rolled back

### 5.4 Rollback Plan

```bash
# Remove symlink
rm ~/.titanium-claws

# Restore legacy paths
# (They were never deleted, just symlinked)

# Restore config
mv ~/.openclaw/openclaw.json.migrated ~/.openclaw/openclaw.json
```

---

## 6. Phase 4: Environment Variables

### 6.1 Scope

| Variable | Current | Target | Fallback |
|----------|---------|--------|----------|
| **State Dir** | `OPENCLAW_STATE_DIR` | `TITANIUM_CLAWS_STATE_DIR` | ✓ |
| **Config Path** | `OPENCLAW_CONFIG_PATH` | `TITANIUM_CLAWS_CONFIG_PATH` | ✓ |
| **Gateway Token** | `OPENCLAW_GATEWAY_TOKEN` | `TITANIUM_CLAWS_GATEWAY_TOKEN` | ✓ |
| **Gateway Password** | `OPENCLAW_GATEWAY_PASSWORD` | `TITANIUM_CLAWS_GATEWAY_PASSWORD` | ✓ |
| **Log Level** | `OPENCLAW_LOG_LEVEL` | `TITANIUM_CLAWS_LOG_LEVEL` | ✓ |
| **Database URL** | `OPENCLAW_DATABASE_URL` | `TITANIUM_CLAWS_DATABASE_URL` | ✓ |
| **Redis URL** | `OPENCLAW_REDIS_URL` | `TITANIUM_CLAWS_REDIS_URL` | ✓ |

### 6.2 Execution Plan

**Step 1: Environment Resolver**
```typescript
// src/identity/environment-resolver.ts
// See 02-IDENTITY-LAYER-SPEC.md for full implementation

export class EnvironmentResolver {
  resolveGatewayToken(): string | undefined {
    return (
      process.env.TITANIUM_CLAWS_GATEWAY_TOKEN ||
      process.env.OPENCLAW_GATEWAY_TOKEN
    )
  }
  
  // ... other methods
}
```

**Step 2: Deprecation Warnings**
```typescript
// src/infra/env-deprecation.ts

const LEGACY_ENV_PREFIXES = ["OPENCLAW_", "CLAWDBOT_", "MOLTBOT_"]

export function checkForLegacyEnvVars(): void {
  const legacyVars = Object.keys(process.env).filter(key =>
    LEGACY_ENV_PREFIXES.some(prefix => key.startsWith(prefix))
  )
  
  if (legacyVars.length > 0) {
    console.warn(`
⚠️  Legacy environment variables detected:
${legacyVars.map(v => `  - ${v}`).join("\n")}

These variables are still supported but will emit warnings.
Consider migrating to TITANIUM_CLAWS_* variables.

Documentation: https://docs.titaniumclaws.ai/migration/environment
    `.trim())
  }
}
```

**Step 3: Environment Documentation**
```markdown
# Environment Variables

## Titanium Claws Variables (Recommended)

| Variable | Description | Default |
|----------|-------------|---------|
| `TITANIUM_CLAWS_STATE_DIR` | State directory path | `~/.titanium-claws` |
| `TITANIUM_CLAWS_CONFIG_PATH` | Configuration file path | `$STATE_DIR/titanium-claws.json` |
| `TITANIUM_CLAWS_GATEWAY_TOKEN` | Gateway authentication token | (required) |
| `TITANIUM_CLAWS_LOG_LEVEL` | Log level | `info` |

## Legacy OpenClaw Variables (Deprecated)

These variables are still supported but will emit warnings.

| Variable | Replacement |
|----------|-------------|
| `OPENCLAW_STATE_DIR` | `TITANIUM_CLAWS_STATE_DIR` |
| `OPENCLAW_CONFIG_PATH` | `TITANIUM_CLAWS_CONFIG_PATH` |
| `OPENCLAW_GATEWAY_TOKEN` | `TITANIUM_CLAWS_GATEWAY_TOKEN` |
| `OPENCLAW_LOG_LEVEL` | `TITANIUM_CLAWS_LOG_LEVEL` |

## Migration

```bash
# Export new variables
export TITANIUM_CLAWS_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
export TITANIUM_CLAWS_STATE_DIR=$OPENCLAW_STATE_DIR
export TITANIUM_CLAWS_CONFIG_PATH=$OPENCLAW_CONFIG_PATH
export TITANIUM_CLAWS_LOG_LEVEL=$OPENCLAW_LOG_LEVEL

# Add to .bashrc or .zshrc
echo "export TITANIUM_CLAWS_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN" >> ~/.bashrc
```
```

### 6.3 Validation Checklist

- [ ] New environment variables work
- [ ] Legacy environment variables still work
- [ ] Deprecation warnings shown for legacy variables
- [ ] Dual resolution works (new takes precedence)
- [ ] Documentation updated
- [ ] Migration guide created
- [ ] Tests cover both new and legacy variables

### 6.4 Rollback Plan

```bash
# No code rollback needed - backward compatibility maintained
# Just remove deprecation warnings if needed
git checkout HEAD~1 -- src/infra/env-deprecation.ts
```

---

## 7. Phase 5: NPM Packages & Imports

### 7.1 Scope

| Component | Current | Target | Automation |
|-----------|---------|--------|------------|
| **Package Scope** | `@openclaw/*` | `@titanium-claws/*` | Semi-automated |
| **Import Statements** | `from "@openclaw/..."` | `from "@titanium-claws/..."` | Automated |
| **Dependencies** | `"@openclaw/core": "..."` | `"@titanium-claws/core": "..."` | Automated |
| **Peer Dependencies** | `@openclaw/*` | `@titanium-claws/*` | Automated |
| **Lock Files** | `pnpm-lock.yaml` | `pnpm-lock.yaml` | Regenerated |

### 7.2 Execution Plan

**Step 1: Package Scope Renaming**
```bash
# Rename all packages in monorepo
node scripts/rename-packages.js \
  --from "@openclaw" \
  --to "@titanium-claws" \
  --packages "packages/*,extensions/*"
```

```json
// packages/core/package.json
{
  "name": "@titanium-claws/core",
  "version": "1.0.0",
  "dependencies": {
    "@titanium-claws/identity": "workspace:*"
  }
}
```

**Step 2: Import Statement Migration**
```bash
# Use AST-aware codemod
node scripts/migrate-imports.js \
  --from "@openclaw" \
  --to "@titanium-claws" \
  --files "src/**/*.ts,extensions/**/*.ts"
```

```typescript
// Before
import { Gateway } from "@openclaw/gateway"
import { PluginSDK } from "@openclaw/plugin-sdk"

// After
import { Gateway } from "@titanium-claws/gateway"
import { PluginSDK } from "@titanium-claws/plugin-sdk"
```

**Step 3: Dependency Updates**
```bash
# Update all package.json files
node scripts/update-dependencies.js \
  --from "@openclaw" \
  --to "@titanium-claws"

# Regenerate lock file
rm pnpm-lock.yaml
pnpm install
```

**Step 4: Backward Compatibility**
```json
// For external plugins that still use @openclaw/*
{
  "name": "@titanium-claws/core",
  "dependencies": {
    "@openclaw/core": "npm:@titanium-claws/core@^1.0.0"
  }
}
```

### 7.3 Validation Checklist

- [ ] All packages renamed
- [ ] All imports updated
- [ ] All dependencies updated
- [ ] Lock file regenerated
- [ ] Packages build successfully
- [ ] Tests pass
- [ ] External plugins still work (backward compatibility)
- [ ] npm publish works

### 7.4 Rollback Plan

```bash
# Revert package names
git checkout HEAD~1 -- packages/*/package.json extensions/*/package.json

# Revert imports
git checkout HEAD~1 -- src/ extensions/

# Revert lock file
git checkout HEAD~1 -- pnpm-lock.yaml

# Reinstall
pnpm install
```

---

## 8. Phase 6: Native Apps & Bundle IDs

### 8.1 Scope

| Platform | Component | Current | Target | Risk |
|----------|-----------|---------|--------|------|
| **macOS** | Bundle ID | `ai.openclawfoundation.app` | `ai.titaniumclaws.app` | High |
| **iOS** | Bundle ID | `ai.openclawfoundation.app` | `ai.titaniumclaws.app` | High |
| **Android** | Application ID | `ai.openclaw.app` | `ai.titaniumclaws.app` | High |
| **Linux** | Desktop Entry | `openclaw.desktop` | `titanium-claws.desktop` | Low |
| **Windows** | Registry | `OpenClaw` | `Titanium Claws` | Medium |

### 8.2 Execution Plan

**Step 1: macOS Bundle ID**
```xml
<!-- apps/macos/OpenClaw/Info.plist -->
<key>CFBundleIdentifier</key>
<string>ai.titaniumclaws.app</string>

<key>CFBundleName</key>
<string>Titanium Claws</string>

<key>CFBundleDisplayName</key>
<string>Titanium Claws</string>
```

**Step 2: iOS Bundle ID**
```xml
<!-- apps/ios/OpenClaw/Info.plist -->
<key>CFBundleIdentifier</key>
<string>ai.titaniumclaws.app</string>

<!-- App Groups -->
<key>com.apple.security.application-groups</key>
<array>
  <string>group.ai.titaniumclaws.app.shared</string>
</array>
```

**Step 3: Android Application ID**
```kotlin
// apps/android/app/build.gradle.kts
android {
    namespace = "ai.titaniumclaws.app"
    
    defaultConfig {
        applicationId = "ai.titaniumclaws.app"
    }
}
```

```kotlin
// Rename package directory
// src/main/java/ai/openclaw/app/ → src/main/java/ai/titaniumclaws/app/
```

**Step 4: Linux Desktop Entry**
```ini
# apps/linux/titanium-claws.desktop
[Desktop Entry]
Name=Titanium Claws
Comment=Rust-Powered Multi-Agent Intelligence
Exec=tc
Icon=titanium-claws
Terminal=false
Type=Application
Categories=Development;AI;
```

**Step 5: Windows Registry**
```nsis
; apps/windows/installer.nsi
!define PRODUCT_NAME "Titanium Claws"
!define PRODUCT_PUBLISHER "Titanium Claws Contributors"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
```

### 8.3 Validation Checklist

- [ ] macOS app builds and installs
- [ ] iOS app builds and installs
- [ ] Android app builds and installs
- [ ] Linux desktop entry works
- [ ] Windows installer works
- [ ] App signing works (macOS, iOS, Windows)
- [ ] App groups work (iOS)
- [ ] Data migration works (if needed)

### 8.4 Rollback Plan

```bash
# Revert bundle IDs
git checkout HEAD~1 -- apps/macos/ apps/ios/ apps/android/ apps/linux/ apps/windows/

# Rebuild apps
cd apps/macos && xcodebuild
cd apps/ios && xcodebuild
cd apps/android && ./gradlew build
```

---

## 9. Phase 7: Internal Namespaces (Optional)

### 9.1 Scope

| Component | Current | Target | Decision |
|-----------|---------|--------|----------|
| **Database Tables** | `openclaw_*` | `titanium_claws_*` | Optional |
| **Protocol Names** | `openclaw` | `titanium` | Optional |
| **Internal Interfaces** | `IOpenClaw*` | `ITitaniumClaws*` | Optional |
| **Telemetry Namespaces** | `openclaw.*` | `titanium_claws.*` | Optional |
| **Migration IDs** | `openclaw-*` | `titanium-claws-*` | Optional |

### 9.2 Decision Framework

**Rename Internal Namespaces If:**
- ✓ Complete independence from OpenClaw is desired
- ✓ No upstream synchronization planned
- ✓ Clean codebase is important for maintainability
- ✓ Team has capacity for additional work

**Keep Internal Namespaces If:**
- ✓ Upstream synchronization is planned
- ✓ Merge conflicts are a concern
- ✓ Team capacity is limited
- ✓ Internal names don't affect users

### 9.3 Recommended Approach: Phase This Work

If renaming internal namespaces:

**Phase 7a: Database Schema (Month 4)**
```sql
-- Create migration
CREATE TABLE migration_history (
  id INTEGER PRIMARY KEY,
  from_schema TEXT NOT NULL,
  to_schema TEXT NOT NULL,
  migrated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rename tables
ALTER TABLE openclaw_agents RENAME TO titanium_claws_agents;
ALTER TABLE openclaw_sessions RENAME TO titanium_claws_sessions;
-- ... other tables
```

**Phase 7b: Protocol Names (Month 5)**
```typescript
// Before
const OPENCLAW_PROTOCOL = "openclaw/1.0"

// After
const TITANIUM_CLAWS_PROTOCOL = "titanium-claws/1.0"
```

**Phase 7c: Internal Interfaces (Month 6)**
```typescript
// Before
interface IOpenClawConfig {
  // ...
}

// After
interface ITitaniumClawsConfig {
  // ...
}
```

### 9.4 Validation Checklist

- [ ] Database migration works
- [ ] Protocol names updated
- [ ] Internal interfaces renamed
- [ ] Tests pass
- [ ] No regressions
- [ ] Upstream sync still works (if applicable)

### 9.5 Rollback Plan

```bash
# Revert database schema
# (Requires database restore from backup)

# Revert protocol names
git checkout HEAD~1 -- src/protocol/

# Revert interfaces
git checkout HEAD~1 -- src/types/
```

---

## 10. Phase 8: Final Validation & Launch

### 10.1 Validation Plan

**Automated Tests**
```bash
# Run full test suite
pnpm test

# Run integration tests
pnpm test:integration

# Run load tests
node benchmarks/run-all.js

# Run security scan
npm audit
cargo audit
```

**Manual Testing**
```bash
# Fresh install
curl -fsSL https://titaniumclaws.ai/install.sh | bash

# Verify installation
tc --version
tc doctor

# Test migration from OpenClaw
tc migrate --from openclaw

# Test all features
tc gateway start
tc agent list
tc workflow run
```

**Compatibility Testing**
```bash
# Test with existing OpenClaw plugins
tc plugin install @openclaw/browser
tc plugin install @openclaw/memory-wiki

# Test with OpenClaw configurations
tc migrate --from openclaw --config-path ~/.openclaw/openclaw.json
```

### 10.2 Launch Checklist

- [ ] All phases completed and validated
- [ ] Documentation complete
- [ ] Website updated
- [ ] Release notes written
- [ ] Announcement prepared
- [ ] Support channels ready
- [ ] Monitoring configured
- [ ] Rollback plan tested

### 10.3 Launch Sequence

**Day 1: Soft Launch**
- Publish to GitHub
- Update documentation
- Notify existing users
- Monitor for issues

**Day 2-7: Monitoring**
- Monitor error rates
- Collect user feedback
- Fix critical issues
- Update documentation

**Day 8-14: General Availability**
- Public announcement
- Blog post
- Social media
- Community events

**Day 15+: Continued Support**
- Regular updates
- Bug fixes
- Feature enhancements
- Community engagement

---

## 11. Risk Assessment & Mitigation

### 11.1 Risk Matrix

| Risk | Probability | Impact | Mitigation | Contingency |
|------|-------------|--------|------------|-------------|
| **Migration failures** | Medium | High | Comprehensive testing, rollback plan | Manual migration |
| **Compatibility breaks** | Low | High | Backward compatibility layer | Hotfix release |
| **Data loss** | Low | Critical | Automated backups, validation | Restore from backup |
| **Performance regressions** | Low | Medium | Benchmark suite, monitoring | Rollback |
| **User confusion** | Medium | Medium | Clear documentation, migration guide | Support channels |
| **Plugin incompatibility** | Medium | Medium | Compatibility testing | Plugin updates |
| **Native app signing** | Medium | High | Early testing, proper certificates | Manual installation |
| **Upstream conflicts** | Medium | Medium | Selective sync strategy | Manual merge |

### 11.2 Mitigation Strategies

**Strategy 1: Automated Backups**
```bash
# Before each phase
./scripts/backup-before-migration.sh

# Creates timestamped backup of entire repository
# Stores in secure location
# Validates backup integrity
```

**Strategy 2: Feature Flags**
```typescript
// Enable/disable migration features
const MIGRATION_ENABLED = process.env.TITANIUM_CLAWS_MIGRATION === "true"

if (MIGRATION_ENABLED) {
  // Use new Titanium Claws paths
} else {
  // Use legacy OpenClaw paths
}
```

**Strategy 3: Dual Execution**
```bash
# Run both OpenClaw and Titanium Claws in parallel
# Compare results
# Validate consistency

./scripts/dual-execution-test.sh
```

**Strategy 4: Canary Releases**
```bash
# Release to 1% of users first
# Monitor for 24 hours
# Gradually increase to 100%

./scripts/canary-release.sh --percentage 1
```

---

## 12. Automation Tools

### 12.1 Migration Scripts

**Script 1: Rename Packages**
```javascript
// scripts/rename-packages.js
import fs from "fs"
import path from "path"

const FROM_SCOPE = "@openclaw"
const TO_SCOPE = "@titanium-claws"

function renamePackages(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const packageJsonPath = path.join(dir, entry.name, "package.json")
      
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(
          fs.readFileSync(packageJsonPath, "utf-8")
        )
        
        if (packageJson.name?.startsWith(FROM_SCOPE)) {
          packageJson.name = packageJson.name.replace(
            FROM_SCOPE,
            TO_SCOPE
          )
          
          fs.writeFileSync(
            packageJsonPath,
            JSON.stringify(packageJson, null, 2)
          )
          
          console.log(`Renamed: ${packageJson.name}`)
        }
      }
    }
  }
}

renamePackages("packages")
renamePackages("extensions")
```

**Script 2: Migrate Imports**
```javascript
// scripts/migrate-imports.js
import fs from "fs"
import path from "path"
import { parse } from "@typescript-eslint/typescript-estree"

const FROM_SCOPE = "@openclaw"
const TO_SCOPE = "@titanium-claws"

function migrateImports(filePath) {
  const content = fs.readFileSync(filePath, "utf-8")
  const ast = parse(content, { loc: true })
  
  let modified = false
  let lines = content.split("\n")
  
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      if (node.source.value.startsWith(FROM_SCOPE)) {
        const newSource = node.source.value.replace(
          FROM_SCOPE,
          TO_SCOPE
        )
        
        const lineIndex = node.loc.start.line - 1
        lines[lineIndex] = lines[lineIndex].replace(
          node.source.value,
          newSource
        )
        
        modified = true
      }
    }
  }
  
  if (modified) {
    fs.writeFileSync(filePath, lines.join("\n"))
    console.log(`Migrated: ${filePath}`)
  }
}

// Find all TypeScript files
function findFiles(dir, pattern) {
  const results = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, pattern))
    } else if (pattern.test(entry.name)) {
      results.push(fullPath)
    }
  }
  
  return results
}

const files = findFiles("src", /\.ts$/)
files.forEach(migrateImports)
```

**Script 3: Validate Migration**
```javascript
// scripts/validate-migration.js
import fs from "fs"

const LEGACY_PATTERNS = [
  /@openclaw\//,
  /OPENCLAW_/,
  /\.openclaw/,
  /openclaw\.json/
]

function validateFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8")
  const violations = []
  
  for (const pattern of LEGACY_PATTERNS) {
    const matches = content.match(pattern)
    if (matches) {
      violations.push({
        pattern: pattern.toString(),
        count: matches.length
      })
    }
  }
  
  return violations
}

// Validate all source files
const files = findFiles("src", /\.ts$/)
let totalViolations = 0

for (const file of files) {
  const violations = validateFile(file)
  
  if (violations.length > 0) {
    console.log(`${file}: ${violations.length} violations`)
    totalViolations += violations.length
  }
}

if (totalViolations > 0) {
  console.log(`\nTotal violations: ${totalViolations}`)
  process.exit(1)
} else {
  console.log("✓ No legacy patterns found")
}
```

### 12.2 CI/CD Integration

```yaml
# .github/workflows/migration-validation.yml
name: Migration Validation

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Build Rust engines
        run: pnpm build:rust
      
      - name: Build TypeScript
        run: pnpm build
      
      - name: Run tests
        run: pnpm test
      
      - name: Validate migration
        run: node scripts/validate-migration.js
      
      - name: Check backward compatibility
        run: node scripts/check-backward-compat.js
      
      - name: Run integration tests
        run: pnpm test:integration
```

---

## 13. Documentation Updates

### 13.1 User Documentation

**Migration Guide**
```markdown
# Migrating from OpenClaw to Titanium Claws

## Quick Migration

```bash
# Install Titanium Claws
curl -fsSL https://titaniumclaws.ai/install.sh | bash

# Migrate from OpenClaw
tc migrate --from openclaw

# Verify migration
tc doctor
```

## What Changes

| Component | OpenClaw | Titanium Claws |
|-----------|----------|----------------|
| CLI Command | `openclaw` | `tc` |
| Config File | `~/.openclaw/openclaw.json` | `~/.titanium-claws/titanium-claws.json` |
| Environment | `OPENCLAW_*` | `TITANIUM_CLAWS_*` |
| Package Scope | `@openclaw/*` | `@titanium-claws/*` |

## Backward Compatibility

Titanium Claws maintains full backward compatibility with OpenClaw:

- ✓ Legacy `openclaw` command still works
- ✓ Legacy `~/.openclaw/` paths still work
- ✓ Legacy `OPENCLAW_*` environment variables still work
- ✓ OpenClaw plugins still work

## Need Help?

- Documentation: https://docs.titaniumclaws.ai/migration
- Support: support@titaniumclaws.ai
- Discord: https://discord.gg/titaniumclaws
```

### 13.2 Developer Documentation

**Migration API**
```markdown
# Migration API

## IdentityService

```typescript
import { IdentityService } from "@titanium-claws/identity"

const identity = new IdentityService(PRODUCT_IDENTITY, LEGACY_IDENTITY)

// Get product information
const name = identity.getDisplayName()  // "Titanium Claws"
const version = identity.getVersion()   // "1.0.0"

// Resolve paths
const configPath = identity.resolveConfigPath()
const stateDir = identity.resolveStateDirectory()

// Resolve environment
const token = identity.resolveGatewayToken()
```

## PathResolver

```typescript
import { PathResolver } from "@titanium-claws/identity"

const resolver = new PathResolver(PRODUCT_IDENTITY, LEGACY_IDENTITY)

// Resolve paths with fallback
const stateDir = resolver.resolveStateDirectory()
// Returns ~/.titanium-claws if exists, else ~/.openclaw
```

## EnvironmentResolver

```typescript
import { EnvironmentResolver } from "@titanium-claws/identity"

const resolver = new EnvironmentResolver(PRODUCT_IDENTITY, LEGACY_IDENTITY)

// Resolve environment with fallback
const token = resolver.resolveGatewayToken()
// Returns TITANIUM_CLAWS_GATEWAY_TOKEN if set, else OPENCLAW_GATEWAY_TOKEN
```
```

---

## 14. Conclusion

This Migration Specification provides a comprehensive, phased approach to transitioning from OpenClaw to Titanium Claws. By following the workstream architecture, executing in phases, and maintaining backward compatibility throughout, we minimize risk while achieving a clean, independent product identity.

**Key Principles:**
1. **Phased Execution**: 8 phases over 16 weeks
2. **Backward Compatibility**: Legacy paths, variables, and commands supported
3. **Automated Where Possible**: AST-aware codemods, not blind find-replace
4. **Validated at Each Stage**: Comprehensive testing before proceeding
5. **Rollback Ready**: Each phase can be reversed

**Next Steps:**
1. Review and approve this specification
2. Set up migration infrastructure (scripts, CI/CD)
3. Begin Phase 1: Branding & Documentation
4. Execute phases sequentially with validation at each stage
5. Launch Titanium Claws as independent product

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **Workstream** | Independent unit of migration work |
| **Phase** | Sequential stage of migration |
| **AST-Aware Codemod** | Code transformation tool using Abstract Syntax Tree |
| **Backward Compatibility** | Support for legacy OpenClaw paths and variables |
| **Rollback** | Process of reverting to previous state |
| **Canary Release** | Gradual rollout to small percentage of users |

## Appendix B: Related Documents

- `01-ARCHITECTURE-RFC.md` - Overall architecture
- `02-IDENTITY-LAYER-SPEC.md` - Identity layer specification
- `04-RELEASE-ENGINEERING-SPEC.md` - Release engineering

## Appendix C: Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-21 | Titanium Claws Team | Initial draft |
