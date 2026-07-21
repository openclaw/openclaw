# Titanium Claws Release Engineering Specification

**Status**: Draft  
**Created**: 2026-07-21  
**Version**: 1.0.0  
**RFC**: See `01-ARCHITECTURE-RFC.md`  
**Migration Spec**: See `03-MIGRATION-SPEC.md`

---

## Executive Summary

This specification defines the **Release Engineering** strategy for Titanium Claws, covering build pipelines, packaging, versioning, distribution channels, and release procedures. A robust release engineering foundation ensures consistent, reproducible builds across all platforms and provides a reliable path for users to install, update, and rollback Titanium Claws.

### Release Engineering Principles

1. **Reproducibility**: Every build produces identical artifacts given the same inputs
2. **Automation**: All release steps are automated and tested
3. **Platform Parity**: Consistent experience across macOS, Linux, Windows, iOS, Android
4. **Security**: Code signing, provenance tracking, vulnerability scanning
5. **User-Friendly**: Simple installation, seamless updates, easy rollback

---

## 1. Release Strategy

### 1.1 Versioning Scheme

**Semantic Versioning 2.0.0**: `MAJOR.MINOR.PATCH`

```
1.0.0   → Initial stable release
1.1.0   → New features, backward compatible
1.1.1   → Bug fixes only
2.0.0   → Breaking changes
```

**Pre-release Identifiers**:
```
1.0.0-alpha.1   → Early alpha
1.0.0-beta.1    → Beta release
1.0.0-rc.1      → Release candidate
1.0.0           → Stable release
```

**Build Metadata** (optional):
```
1.0.0+build.123
1.0.0+20260721
```

### 1.2 Release Channels

| Channel | Purpose | Frequency | Stability |
|---------|---------|-----------|-----------|
| **Stable** | Production use | Monthly | High |
| **Beta** | Early access | Bi-weekly | Medium |
| **Alpha** | Experimental | Weekly | Low |
| **Nightly** | Development | Daily | Unstable |

### 1.3 Release Cadence

| Phase | Duration | Release Type | Target |
|-------|----------|--------------|--------|
| **Development** | Months 1-3 | Alpha | Internal testing |
| **Beta** | Month 4 | Beta | Community feedback |
| **Release Candidate** | Month 5 | RC | Final validation |
| **Stable** | Month 6 | GA | General availability |

---

## 2. Build Pipeline Architecture

### 2.1 Pipeline Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Build Pipeline                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Source Code                                             │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Stage 1: Lint & Type Check                      │  │
│  │  - ESLint, Prettier                              │  │
│  │  - TypeScript type checking                      │  │
│  │  - Rust clippy                                   │  │
│  └──────────────────────────────────────────────────┘  │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Stage 2: Build Rust Engines                     │  │
│  │  - cargo build --release                         │  │
│  │  - NAPI-RS bindings                              │  │
│  │  - Platform-specific binaries                    │  │
│  └──────────────────────────────────────────────────┘  │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Stage 3: Build TypeScript                       │  │
│  │  - tsc compilation                               │  │
│  │  - Bundle optimization                           │  │
│  │  - Asset processing                              │  │
│  └──────────────────────────────────────────────────┘  │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Stage 4: Test                                   │  │
│  │  - Unit tests                                    │  │
│  │  - Integration tests                             │  │
│  │  - Benchmark tests                               │  │
│  └──────────────────────────────────────────────────┘  │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Stage 5: Package                               │  │
│  │  - Platform-specific packages                    │  │
│  │  - Code signing                                  │  │
│  │  - Checksum generation                           │  │
│  └──────────────────────────────────────────────────┘  │
│       │                                                  │
│       ▼                                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Stage 6: Release                               │  │
│  │  - GitHub Releases                               │  │
│  │  - NPM Registry                                  │  │
│  │  - Docker Hub                                    │  │
│  │  - Homebrew, Scoop, APT                          │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 CI/CD Platform

**Primary**: GitHub Actions  
**Backup**: GitLab CI (if GitHub Actions unavailable)

**Workflow Triggers**:
```yaml
on:
  push:
    branches: [main, develop]
    tags: ['v*']
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 0 * * *'  # Nightly builds
```

### 2.3 Build Matrix

| Platform | Architecture | Target | Runner |
|----------|--------------|--------|--------|
| **macOS** | x86_64 | `darwin-x64` | `macos-latest` |
| **macOS** | arm64 | `darwin-arm64` | `macos-latest` |
| **Linux** | x86_64 | `linux-x64` | `ubuntu-latest` |
| **Linux** | arm64 | `linux-arm64` | `ubuntu-latest` |
| **Windows** | x86_64 | `win32-x64` | `windows-latest` |
| **iOS** | arm64 | `ios-arm64` | `macos-latest` |
| **Android** | arm64 | `android-arm64` | `ubuntu-latest` |

---

## 3. Build Stages

### 3.1 Stage 1: Lint & Type Check

```yaml
# .github/workflows/build.yml
name: Build

on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Lint TypeScript
        run: pnpm lint
      
      - name: Check formatting
        run: pnpm format:check
      
      - name: Type check
        run: pnpm tsc --noEmit
      
      - name: Lint Rust
        run: cargo clippy --all-targets --all-features -- -D warnings
```

### 3.2 Stage 2: Build Rust Engines

```yaml
  build-rust:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: x86_64-apple-darwin
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - os: ubuntu-latest
            target: aarch64-unknown-linux-gnu
          - os: windows-latest
            target: x86_64-pc-windows-msvc
    
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      
      - name: Build Rust engines
        run: |
          cd crates
          cargo build --release --target ${{ matrix.target }}
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: rust-engines-${{ matrix.target }}
          path: crates/target/${{ matrix.target }}/release/
```

### 3.3 Stage 3: Build TypeScript

```yaml
  build-typescript:
    needs: [lint, build-rust]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Download Rust artifacts
        uses: actions/download-artifact@v3
        with:
          name: rust-engines-*
          path: crates/target/release/
      
      - name: Build TypeScript
        run: pnpm build
      
      - name: Upload build artifacts
        uses: actions/upload-artifact@v3
        with:
          name: typescript-build
          path: dist/
```

### 3.4 Stage 4: Test

```yaml
  test:
    needs: [build-typescript]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Download build artifacts
        uses: actions/download-artifact@v3
        with:
          name: typescript-build
          path: dist/
      
      - name: Run unit tests
        run: pnpm test
      
      - name: Run integration tests
        run: pnpm test:integration
      
      - name: Run benchmarks
        run: node benchmarks/run-all.js
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info
```

### 3.5 Stage 5: Package

```yaml
  package:
    needs: [test]
    strategy:
      matrix:
        platform: [darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64]
    
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Download build artifacts
        uses: actions/download-artifact@v3
        with:
          name: typescript-build
          path: dist/
      
      - name: Package for ${{ matrix.platform }}
        run: |
          node scripts/package.js \
            --platform ${{ matrix.platform }} \
            --output releases/
      
      - name: Sign packages
        run: |
          node scripts/sign-packages.js \
            --input releases/ \
            --output releases/signed/
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
          WINDOWS_PASSWORD: ${{ secrets.WINDOWS_PASSWORD }}
      
      - name: Generate checksums
        run: |
          cd releases/signed
          sha256sum * > SHA256SUMS
      
      - name: Upload release artifacts
        uses: actions/upload-artifact@v3
        with:
          name: releases-${{ matrix.platform }}
          path: releases/signed/
```

### 3.6 Stage 6: Release

```yaml
  release:
    needs: [package]
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Download all release artifacts
        uses: actions/download-artifact@v3
        with:
          path: releases/
      
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          files: releases/**/*
          draft: false
          prerelease: ${{ contains(github.ref, 'alpha') || contains(github.ref, 'beta') }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Publish to NPM
        run: |
          npm config set //registry.npmjs.org/:_authToken ${{ secrets.NPM_TOKEN }}
          npm publish --access public
        if: ${{ !contains(github.ref, 'alpha') && !contains(github.ref, 'beta') }}
      
      - name: Push to Docker Hub
        run: |
          echo ${{ secrets.DOCKER_PASSWORD }} | docker login -u ${{ secrets.DOCKER_USERNAME }} --password-stdin
          docker build -t titaniumclaws/titanium-claws:${{ github.ref_name }} .
          docker push titaniumclaws/titanium-claws:${{ github.ref_name }}
```

---

## 4. Packaging Strategy

### 4.1 Platform-Specific Packages

#### macOS

**Format**: `.pkg` installer + `.dmg` disk image

```bash
# Package structure
titanium-claws-1.0.0-macos-x64.pkg
titanium-claws-1.0.0-macos-arm64.pkg
titanium-claws-1.0.0-macos-x64.dmg
titanium-claws-1.0.0-macos-arm64.dmg
```

**Installer Features**:
- Universal binary support
- Code signing with Apple Developer ID
- Notarization for Gatekeeper
- Automatic PATH configuration
- Uninstaller included

#### Linux

**Format**: `.deb` (Debian/Ubuntu) + `.rpm` (Fedora/RHEL) + `.tar.gz` (generic)

```bash
# Debian package
titanium-claws_1.0.0_amd64.deb
titanium-claws_1.0.0_arm64.deb

# RPM package
titanium-claws-1.0.0-1.x86_64.rpm
titanium-claws-1.0.0-1.aarch64.rpm

# Generic tarball
titanium-claws-1.0.0-linux-x64.tar.gz
titanium-claws-1.0.0-linux-arm64.tar.gz
```

**Package Contents**:
```
/opt/titanium-claws/
  bin/tc                    # CLI executable
  lib/                      # Shared libraries
  etc/                      # Configuration templates
  
/usr/local/bin/tc          # Symlink to CLI
/etc/titanium-claws/        # System configuration
/var/lib/titanium-claws/    # State directory
/var/log/titanium-claws/    # Log directory

/lib/systemd/system/
  titanium-claws-gateway.service  # Systemd service
```

#### Windows

**Format**: `.msi` installer + `.exe` portable

```bash
# MSI installer
titanium-claws-1.0.0-win32-x64.msi

# Portable executable
titanium-claws-1.0.0-win32-x64.exe
```

**Installer Features**:
- Code signing with Windows certificate
- Automatic PATH configuration
- Start menu shortcuts
- Uninstaller with registry cleanup
- Optional service installation

### 4.2 Native App Packages

#### iOS

**Format**: `.ipa` file (App Store + TestFlight)

```bash
titanium-claws-1.0.0-ios.ipa
```

**Distribution**:
- App Store (production)
- TestFlight (beta testing)
- Enterprise (internal distribution)

#### Android

**Format**: `.apk` (direct) + `.aab` (Play Store)

```bash
titanium-claws-1.0.0-android.apk
titanium-claws-1.0.0-android.aab
```

**Distribution**:
- Google Play Store (production)
- Internal testing track (beta)
- Direct APK download

### 4.3 Container Images

**Docker Hub**: `titaniumclaws/titanium-claws`

**Tags**:
```
latest              → Latest stable release
1.0.0               → Specific version
1.0                 → Latest patch release
1                   → Latest minor release
beta                → Latest beta release
nightly             → Latest nightly build
```

**Dockerfile**:
```dockerfile
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build:rust
RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

EXPOSE 18789 18793 9090

ENTRYPOINT ["node", "dist/index.js"]
CMD ["gateway"]
```

---

## 5. Code Signing & Security

### 5.1 Code Signing Strategy

| Platform | Method | Certificate | Storage |
|----------|--------|-------------|---------|
| **macOS** | Apple Developer ID | Developer ID Application | Keychain |
| **iOS** | Apple Distribution | Distribution Certificate | Keychain |
| **Windows** | Authenticode | Code Signing Certificate | Certificate Store |
| **Linux** | GPG (optional) | GPG Key | GPG Keyring |
| **Android** | JKS Keystore | Release Keystore | Keystore File |

### 5.2 macOS Code Signing

```bash
#!/bin/bash
# scripts/sign-macos.sh

set -euo pipefail

APP_NAME="Titanium Claws"
BUNDLE_ID="ai.titaniumclaws.app"
CERTIFICATE="Developer ID Application: Titanium Claws Contributors (TEAMID)"

# Sign application
codesign --force --options runtime --sign "$CERTIFICATE" \
  --timestamp \
  dist/titanium-claws.app/Contents/MacOS/tc

# Notarize
xcrun notarytool submit dist/titanium-claws.app \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$TEAM_ID" \
  --wait

# Staple
xcrun stapler staple dist/titanium-claws.app
```

### 5.3 Windows Code Signing

```powershell
# scripts/sign-windows.ps1

$certPath = "certs\windows-code-signing.pfx"
$password = $env:WINDOWS_CERTIFICATE_PASSWORD
$timestampUrl = "http://timestamp.digicert.com"

signtool sign /f $certPath /p $password /tr $timestampUrl /td sha256 /fd sha256 `
  dist\titanium-claws.exe
```

### 5.4 Provenance Tracking

**SLSA Level 3** compliance:

```yaml
# Generate provenance attestation
name: Generate Provenance

on:
  release:
    types: [published]

jobs:
  provenance:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: write
      id-token: write
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Generate build provenance
        uses: actions/attest-build-provenance@v1
        with:
          subject-path: releases/**/*
```

### 5.5 Vulnerability Scanning

```yaml
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          format: 'sarif'
          output: 'trivy-results.sarif'
      
      - name: Upload to GitHub Security
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'
      
      - name: Run npm audit
        run: npm audit --audit-level=high
      
      - name: Run cargo audit
        run: cargo audit
```

---

## 6. Distribution Channels

### 6.1 Primary Channels

#### GitHub Releases

**URL**: `https://github.com/titanium-claws/titanium-claws/releases`

**Assets**:
- Source code (tar.gz, zip)
- Platform-specific binaries
- Checksums (SHA256SUMS)
- Provenance attestations
- Release notes

#### NPM Registry

**Package**: `@titanium-claws/core`

```bash
# Install
npm install @titanium-claws/core

# Update
npm update @titanium-claws/core
```

**Distribution Tags**:
```
latest    → Latest stable
beta      → Latest beta
alpha     → Latest alpha
next      → Next major version
```

#### Docker Hub

**Repository**: `titaniumclaws/titanium-claws`

```bash
# Pull
docker pull titaniumclaws/titanium-claws:latest

# Run
docker run -p 18789:18789 titaniumclaws/titanium-claws:latest
```

### 6.2 Package Managers

#### Homebrew (macOS/Linux)

```ruby
# Formula: titanium-claws.rb
class TitaniumClaws < Formula
  desc "Rust-Powered Multi-Agent Intelligence"
  homepage "https://titaniumclaws.ai"
  url "https://github.com/titanium-claws/titanium-claws/releases/download/v1.0.0/titanium-claws-1.0.0-macos-arm64.tar.gz"
  sha256 "..."
  
  def install
    bin.install "tc"
  end
  
  test do
    system "#{bin}/tc", "--version"
  end
end
```

**Installation**:
```bash
brew install titanium-claws/titanium-claws/titanium-claws
```

#### Scoop (Windows)

```json
// bucket/titanium-claws.json
{
  "version": "1.0.0",
  "description": "Rust-Powered Multi-Agent Intelligence",
  "homepage": "https://titaniumclaws.ai",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "https://github.com/titanium-claws/titanium-claws/releases/download/v1.0.0/titanium-claws-1.0.0-win32-x64.zip",
      "hash": "..."
    }
  },
  "bin": "tc.exe"
}
```

**Installation**:
```powershell
scoop bucket add titanium-claws https://github.com/titanium-claws/scoop-bucket
scoop install titanium-claws
```

#### APT (Debian/Ubuntu)

```bash
# Add repository
curl -fsSL https://apt.titaniumclaws.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/titanium-claws.gpg
echo "deb [signed-by=/usr/share/keyrings/titanium-claws.gpg] https://apt.titaniumclaws.ai stable main" | sudo tee /etc/apt/sources.list.d/titanium-claws.list

# Install
sudo apt update
sudo apt install titanium-claws
```

#### Chocolatey (Windows)

```xml
<!-- titanium-claws.nuspec -->
<package>
  <id>titanium-claws</id>
  <version>1.0.0</version>
  <title>Titanium Claws</title>
  <authors>Titanium Claws Contributors</authors>
  <description>Rust-Powered Multi-Agent Intelligence</description>
  <files>
    <file src="tools\**" target="tools" />
  </files>
</package>
```

**Installation**:
```powershell
choco install titanium-claws
```

### 6.3 Update Mechanisms

#### Automatic Updates (Desktop Apps)

**Sparkle Framework** (macOS):
```swift
// Check for updates
let updater = SUUpdater.shared()
updater?.feedURL = URL(string: "https://titaniumclaws.ai/appcast.xml")
updater?.checkForUpdatesInBackground()
```

**Squirrel.Windows** (Windows):
```csharp
// Check for updates
var updateManager = new UpdateManager(@"https://releases.titaniumclaws.ai");
var updates = await updateManager.CheckForUpdate();
```

#### CLI Updates

```bash
# Check for updates
tc update --check

# Update to latest
tc update

# Update to specific version
tc update --version 1.1.0
```

---

## 7. Release Procedures

### 7.1 Release Checklist

**Pre-Release**
- [ ] All tests passing on CI
- [ ] No critical security vulnerabilities
- [ ] Documentation updated
- [ ] Changelog written
- [ ] Version bumped in package.json
- [ ] Git tag created
- [ ] Release notes drafted

**Release**
- [ ] GitHub Release created
- [ ] Assets uploaded
- [ ] NPM package published
- [ ] Docker image pushed
- [ ] Homebrew formula updated
- [ ] Scoop manifest updated
- [ ] APT repository updated
- [ ] Chocolatey package published

**Post-Release**
- [ ] Announcement published
- [ ] Documentation deployed
- [ ] Social media updated
- [ ] Community notified
- [ ] Monitoring configured
- [ ] Support channels ready

### 7.2 Release Script

```bash
#!/bin/bash
# scripts/release.sh

set -euo pipefail

VERSION=${1:?"Usage: $0 <version>"}

echo "Releasing version $VERSION..."

# Validate version format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$'; then
  echo "Invalid version format: $VERSION"
  exit 1
fi

# Update version in package.json
jq --arg version "$VERSION" '.version = $version' package.json > package.json.tmp
mv package.json.tmp package.json

# Update CHANGELOG
node scripts/generate-changelog.js --version "$VERSION"

# Commit changes
git add package.json CHANGELOG.md
git commit -m "chore: release v$VERSION"

# Create tag
git tag "v$VERSION"

# Push changes
git push origin main
git push origin "v$VERSION"

echo "Release v$VERSION created successfully!"
echo "CI/CD pipeline will now build and publish artifacts."
```

### 7.3 Hotfix Procedure

```bash
#!/bin/bash
# scripts/hotfix.sh

set -euo pipefail

PATCH_VERSION=${1:?"Usage: $0 <patch-version>"}

echo "Creating hotfix $PATCH_VERSION..."

# Create hotfix branch
git checkout -b "hotfix-$PATCH_VERSION" main

# Apply fixes
# ... (make changes)

# Test
pnpm test

# Commit
git add .
git commit -m "fix: hotfix $PATCH_VERSION"

# Create tag
git tag "v$PATCH_VERSION"

# Push
git push origin "hotfix-$PATCH_VERSION"
git push origin "v$PATCH_VERSION"

# Merge back to main
git checkout main
git merge "hotfix-$PATCH_VERSION"
git push origin main

# Cleanup
git branch -d "hotfix-$PATCH_VERSION"

echo "Hotfix $PATCH_VERSION released successfully!"
```

---

## 8. Monitoring & Metrics

### 8.1 Release Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Build Time** | < 15 minutes | CI pipeline duration |
| **Test Coverage** | > 90% | Coverage report |
| **Security Vulnerabilities** | 0 critical | Trivy scan |
| **Download Success Rate** | > 99% | CDN metrics |
| **Update Success Rate** | > 95% | Telemetry |
| **Rollback Rate** | < 1% | Release tracking |

### 8.2 Monitoring Stack

**Prometheus Metrics**:
```typescript
// src/metrics/release.ts
import { Counter, Histogram } from 'prom-client';

export const releaseDownloads = new Counter({
  name: 'titanium_claws_release_downloads_total',
  help: 'Total number of release downloads',
  labelNames: ['version', 'platform', 'channel']
});

export const releaseDuration = new Histogram({
  name: 'titanium_claws_release_duration_seconds',
  help: 'Time taken to download and install release',
  labelNames: ['version', 'platform']
});

export const updateCheckFrequency = new Counter({
  name: 'titanium_claws_update_checks_total',
  help: 'Total number of update checks',
  labelNames: ['current_version', 'result']
});
```

### 8.3 Telemetry (Opt-in)

```typescript
// src/telemetry/release.ts
export class ReleaseTelemetry {
  async trackDownload(version: string, platform: string): Promise<void> {
    if (!this.isEnabled()) return;
    
    await fetch('https://telemetry.titaniumclaws.ai/download', {
      method: 'POST',
      body: JSON.stringify({
        version,
        platform,
        timestamp: new Date().toISOString()
      })
    });
  }
  
  async trackUpdate(fromVersion: string, toVersion: string): Promise<void> {
    if (!this.isEnabled()) return;
    
    await fetch('https://telemetry.titaniumclaws.ai/update', {
      method: 'POST',
      body: JSON.stringify({
        fromVersion,
        toVersion,
        timestamp: new Date().toISOString()
      })
    });
  }
}
```

---

## 9. Rollback Procedures

### 9.1 Automatic Rollback

**Trigger Conditions**:
- Critical bug reported within 24 hours
- Security vulnerability discovered
- > 5% error rate increase
- > 10% performance degradation

**Rollback Script**:
```bash
#!/bin/bash
# scripts/rollback.sh

set -euo pipefail

CURRENT_VERSION=${1:?"Usage: $0 <current-version>"}
TARGET_VERSION=${2:?"Usage: $0 <current-version> <target-version>"}

echo "Rolling back from $CURRENT_VERSION to $TARGET_VERSION..."

# Revert git tag
git tag -d "v$CURRENT_VERSION"
git push origin ":refs/tags/v$CURRENT_VERSION"

# Revert package.json
jq --arg version "$TARGET_VERSION" '.version = $version' package.json > package.json.tmp
mv package.json.tmp package.json

# Commit
git add package.json
git commit -m "revert: rollback to v$TARGET_VERSION"

# Push
git push origin main

# Create new tag
git tag "v$TARGET_VERSION-hotfix"
git push origin "v$TARGET_VERSION-hotfix"

echo "Rollback to v$TARGET_VERSION completed!"
```

### 9.2 Manual Rollback

**User-Initiated Rollback**:
```bash
# Downgrade to previous version
tc update --version 0.9.0

# Or uninstall and reinstall
npm uninstall -g @titanium-claws/core
npm install -g @titanium-claws/core@0.9.0
```

**Configuration Rollback**:
```bash
# Restore previous configuration
tc config restore --backup ~/.titanium-claws/backups/config-20260720.json
```

---

## 10. Documentation & Communication

### 10.1 Release Notes Template

```markdown
# Titanium Claws v1.0.0 Release Notes

**Release Date**: July 21, 2026  
**Compatibility**: OpenClaw 2026.7.2+

## 🎉 What's New

### Performance Improvements
- **100x faster vector search** with HNSW indexing
- **10x faster text search** with BM25 ranking
- **50x faster embedding generation** with GPU acceleration

### Multi-Agent Orchestration
- 6 specialized agents (PRIME, RESEARCH, CODE, OPS, MEMORY, CRITIC)
- A2A protocol for agent coordination
- Task coordinator for workflow management

### Production Features
- Comprehensive monitoring with Prometheus + Grafana
- Automation suite for operations
- Zero-downtime deployment support

## 🐛 Bug Fixes
- Fixed memory leak in gateway process
- Resolved race condition in agent coordination
- Fixed configuration migration from OpenClaw

## ⚠️ Breaking Changes
- Configuration paths changed from `~/.openclaw` to `~/.titanium-claws`
- Environment variables changed from `OPENCLAW_*` to `TITANIUM_CLAWS_*`
- CLI command changed from `openclaw` to `tc`

**Note**: Backward compatibility is maintained. Legacy paths and variables continue to work.

## 📦 Installation

### macOS
```bash
brew install titanium-claws/titanium-claws/titanium-claws
```

### Linux (Debian/Ubuntu)
```bash
curl -fsSL https://apt.titaniumclaws.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/titanium-claws.gpg
echo "deb [signed-by=/usr/share/keyrings/titanium-claws.gpg] https://apt.titaniumclaws.ai stable main" | sudo tee /etc/apt/sources.list.d/titanium-claws.list
sudo apt update && sudo apt install titanium-claws
```

### Windows
```powershell
scoop bucket add titanium-claws https://github.com/titanium-claws/scoop-bucket
scoop install titanium-claws
```

### Docker
```bash
docker pull titaniumclaws/titanium-claws:1.0.0
```

### NPM
```bash
npm install -g @titanium-claws/core
```

## 🔄 Migration from OpenClaw

```bash
# Install Titanium Claws
curl -fsSL https://titaniumclaws.ai/install.sh | bash

# Migrate configuration
tc migrate --from openclaw

# Verify migration
tc doctor
```

## 📚 Documentation
- [Full Documentation](https://docs.titaniumclaws.ai)
- [Migration Guide](https://docs.titaniumclaws.ai/migration)
- [API Reference](https://docs.titaniumclaws.ai/api)

## 🤝 Contributing
- [GitHub Repository](https://github.com/titanium-claws/titanium-claws)
- [Contributing Guide](https://github.com/titanium-claws/titanium-claws/blob/main/CONTRIBUTING.md)
- [Discord Community](https://discord.gg/titaniumclaws)

## 📝 Changelog
See [CHANGELOG.md](https://github.com/titanium-claws/titanium-claws/blob/main/CHANGELOG.md) for detailed changes.

## 🙏 Acknowledgments
Thanks to all contributors who made this release possible!
```

### 10.2 Announcement Templates

**Blog Post**:
```markdown
# Introducing Titanium Claws: Rust-Powered Multi-Agent Intelligence

We're thrilled to announce the release of **Titanium Claws**, a high-performance evolution of OpenClaw that brings Rust-powered performance and advanced multi-agent capabilities to your AI infrastructure.

## The Journey

OpenClaw has been an incredible success, powering thousands of AI assistants worldwide. But we knew we could push the boundaries further. Today, we're proud to introduce Titanium Claws.

## What Makes Titanium Claws Special

**Performance**: Our Rust-native engines deliver 10-100x performance improvements:
- Vector search: 100x faster
- Text search: 10x faster
- Embedding generation: 50x faster

**Multi-Agent Intelligence**: Six specialized agents work together to solve complex problems:
- PRIME: Orchestrator and coordinator
- RESEARCH: Web research and information synthesis
- CODE: Software engineering and execution
- OPS: Infrastructure and DevOps automation
- MEMORY: Memory management and organization
- CRITIC: Quality assurance and validation

**Production-Ready**: Built for enterprise deployments with:
- Comprehensive monitoring and observability
- Automation suite for operations
- Zero-downtime deployment support
- Backward compatibility with OpenClaw

## Getting Started

Installation is simple:

```bash
curl -fsSL https://titaniumclaws.ai/install.sh | bash
tc migrate --from openclaw
```

## Join the Community

- **Documentation**: https://docs.titaniumclaws.ai
- **GitHub**: https://github.com/titanium-claws/titanium-claws
- **Discord**: https://discord.gg/titaniumclaws

The lobster has titanium claws. 🦞⚡
```

**Social Media**:
```
🎉 Introducing Titanium Claws!

🦞→⚡ Rust-Powered Multi-Agent Intelligence

✅ 100x faster vector search
✅ 10x faster text search
✅ 6 specialized AI agents
✅ Production-ready monitoring

The lobster has titanium claws.

🔗 https://titaniumclaws.ai
📚 https://docs.titaniumclaws.ai
💻 https://github.com/titanium-claws

#TitaniumClaws #AI #Rust #OpenSource
```

---

## 11. Conclusion

This Release Engineering Specification provides a comprehensive foundation for building, packaging, distributing, and maintaining Titanium Claws releases. By following these procedures, we ensure:

1. **Consistency**: Reproducible builds across all platforms
2. **Security**: Code signing, vulnerability scanning, provenance tracking
3. **User Experience**: Simple installation, seamless updates, easy rollback
4. **Reliability**: Automated testing, monitoring, and rollback procedures
5. **Community**: Clear communication, documentation, and support

**Next Steps:**
1. Implement CI/CD pipeline (GitHub Actions)
2. Set up code signing infrastructure
3. Configure distribution channels (NPM, Docker, Homebrew, etc.)
4. Create release scripts and automation
5. Establish monitoring and telemetry
6. Document release procedures
7. Conduct first release (v1.0.0-alpha.1)

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **SLSA** | Supply-chain Levels for Software Artifacts |
| **Provenance** | Record of software build process |
| **Code Signing** | Digital signature for software authenticity |
| **Notarization** | Apple's malware scanning service |
| **Rollback** | Reverting to previous software version |
| **Telemetry** | Usage data collection (opt-in) |

## Appendix B: Related Documents

- `01-ARCHITECTURE-RFC.md` - Overall architecture
- `02-IDENTITY-LAYER-SPEC.md` - Identity layer
- `03-MIGRATION-SPEC.md` - Migration specification

## Appendix C: Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-21 | Titanium Claws Team | Initial draft |
