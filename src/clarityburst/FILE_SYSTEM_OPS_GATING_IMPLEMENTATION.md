# FILE_SYSTEM_OPS Execution-Boundary Gating Implementation

**Status:** Foundation complete. Initial validation tests passing (30/30). Strategic wiring examples documented.

## Overview

This document describes the FILE_SYSTEM_OPS execution-boundary gating foundation, analogous to the NETWORK_IO pattern, that enforces security checks before filesystem mutations occur in OpenClaw.

## Architecture

### Core Components

1. **Gating Module** (`src/clarityburst/file-system-ops-gating.ts`)
   - Reusable wrapper functions for high-risk filesystem operations
   - Type-safe abstraction over `fs.promises` operations
   - Structured logging with operation, path, contractId, and outcome
   - Execution barrier: gate executes before fs operation

2. **Override Function** (existing in `src/clarityburst/decision-override.ts`)
   - `applyFileSystemOverrides()` - routes FILE_SYSTEM_OPS decisions through ClarityBurst
   - Honors pack thresholds: `min_confidence_T`, `dominance_margin_Delta`
   - Fail-closed on router unavailable (when flag set)
   - Deterministic confirmation messaging

3. **Test Suite** (`src/clarityburst/__tests__/file_system_ops.gating.simple.test.ts`)
   - 30 focused tests validating:
     - Gate abstention prevents filesystem side effects
     - Gate approval allows operations unchanged
     - Operation type and path extraction
     - Execution order: gate → fs operation
     - Error properties on abstention
     - Structured logging context

## Reusable Wrapper Functions

### applyFileSystemOpsGateAndWrite

```typescript
export async function applyFileSystemOpsGateAndWrite(
  filePath: string,
  data: string | Buffer,
  encoding?: BufferEncoding
): Promise<void>
```

**Pattern:**

```typescript
// Instead of:
await fs.promises.writeFile(path, data, encoding);

// Use:
await applyFileSystemOpsGateAndWrite(path, data, encoding);
```

**Effect:**

1. Routes context through `applyFileSystemOverrides()`
2. On ABSTAIN outcome: throws `ClarityBurstAbstainError` (fs never touched)
3. On PROCEED: calls `fsPromises.writeFile()` unchanged
4. Logs decision with ontology=`FILE_SYSTEM_OPS`, operation=`write`, path, contractId, outcome

### applyFileSystemOpsGateAndAppend

```typescript
export async function applyFileSystemOpsGateAndAppend(
  filePath: string,
  data: string | Buffer,
  encoding?: BufferEncoding
): Promise<void>
```

Mirrors write pattern, operation type = `append`.

### applyFileSystemOpsGateAndRm

```typescript
export async function applyFileSystemOpsGateAndRm(
  filePath: string,
  recursive: boolean = false
): Promise<void>
```

Mirrors write pattern, operation type = `delete`. Executes `fsPromises.rm()`.

### applyFileSystemOpsGateAndRename

```typescript
export async function applyFileSystemOpsGateAndRename(
  oldPath: string,
  newPath: string
): Promise<void>
```

Logs old path as operation target. Executes `fsPromises.rename()`.

### applyFileSystemOpsGateAndMkdir

```typescript
export async function applyFileSystemOpsGateAndMkdir(
  dirPath: string,
  recursive: boolean = true
): Promise<void>
```

Operation type = `mkdir`. Executes `fsPromises.mkdir()`.

### applyFileSystemOpsGateAndCopy

```typescript
export async function applyFileSystemOpsGateAndCopy(
  src: string,
  dest: string
): Promise<void>
```

Logs src as operation target. Executes `fsPromises.copyFile()`.

## High-Risk Mutation Call Sites

### Identified Commit Points (Priority Order)

#### 1. **Configuration File Writes** (CRITICAL)

Location: `src/config/io.ts:1236`

- File: Configuration persistence
- Operation: `writeFile(tmp, json, encoding)`
- Risk: Unauthorized config modifications
- Recommendation: **Wire immediately** - this is a primary security boundary

Current code:

```typescript
await deps.fs.promises.writeFile(tmp, json, {
  encoding: "utf-8",
```

Should become:

```typescript
import { applyFileSystemOpsGateAndWrite } from "../clarityburst/file-system-ops-gating.js";

await applyFileSystemOpsGateAndWrite(tmp, json, "utf-8");
```

#### 2. **Session Store Writes** (CRITICAL - Phase 3 Commit Point)

Locations:

- `src/config/sessions/store.ts:781` - primary write
- `src/config/sessions/store.ts:821` - fallback write  
- `src/config/sessions/store.ts:835` - directory creation + write

Risk: Unauthorized session modification (already gated at this location per phase 3)
Status: Already has gating in place via `loadPackOrAbstain("FILE_SYSTEM_OPS")`
Current: Phase 3 implementation uses commit-point evaluation

#### 3. **Cron Job Store Writes** (HIGH)

Location: `src/cron/store.ts:55-56`

- Operation: `writeFile(tmp, json)` → `rename(tmp, storePath)`
- Risk: Unauthorized cron job injection
- Recommendation: Wire - cron modifications are privileged

Current code:

```typescript
const json = JSON.stringify(store, null, 2);
await fs.promises.writeFile(tmp, json, "utf-8");
await fs.promises.rename(tmp, storePath);
```

Should become:

```typescript
import { applyFileSystemOpsGateAndWrite, applyFileSystemOpsGateAndRename } from "../clarityburst/file-system-ops-gating.js";

const json = JSON.stringify(store, null, 2);
await applyFileSystemOpsGateAndWrite(tmp, json, "utf-8");
await applyFileSystemOpsGateAndRename(tmp, storePath);
```

#### 4. **systemd Unit File Installation** (MEDIUM-HIGH)

Location: `src/daemon/systemd.ts:215`

- Operation: `fs.writeFile(unitPath, unit, "utf8")`
- Risk: Unauthorized systemd service installation
- Recommendation: Wire - platform-specific daemon control

#### 5. **launchd Plist Installation** (MEDIUM-HIGH, macOS only)

Location: `src/daemon/launchd.ts:409`

- Operation: `fs.writeFile(plistPath, plist, "utf8")`
- Risk: Unauthorized launchd service installation
- Recommendation: Wire - macOS-specific daemon control

#### 6. **Discord Voice WAV File Creation** (MEDIUM)

Location: `src/discord/voice/manager.ts:223`

- Operation: `fs.writeFile(filePath, wav)`
- Risk: Unauthorized temporary file injection
- Recommendation: Wire - temporary file creation in sensitive context

#### 7. **Device Identity Store** (MEDIUM)

Location: `src/infra/device-identity.ts:84, 116`

- Operation: `fs.writeFileSync(filePath, ...)`
- Risk: Device identity tampering
- Recommendation: Wire - affects bot identity

#### 8. **Device Auth Store** (MEDIUM)

Location: `src/infra/device-auth-store.ts:38`

- Operation: `fs.writeFileSync(filePath, ...)`
- Risk: Auth credential tampering
- Recommendation: Wire - affects authentication

#### 9. **Approval Decisions** (MEDIUM)

Location: `src/infra/exec-approvals.ts:336`

- Operation: `fs.writeFileSync(filePath, ...)`
- Risk: Unauthorized command approvals
- Recommendation: Wire - command execution gating

#### 10. **Heartbeat Transcript Files** (LOW-MEDIUM)

Location: `src/cron/run-log.ts:120-121`

- Operations: `writeFile()`, `rename()`
- Risk: Transcript tampering
- Recommendation: Wire - audit trail integrity

#### 11. **Session Transcript File Creation** (LOW-MEDIUM)

Location: `src/config/sessions/transcript.ts:76`

- Operation: `fs.promises.writeFile()`
- Risk: Session history manipulation
- Recommendation: Wire - audit trail

#### 12. **Hook Installation** (LOW)

Location: `src/hooks/bundled/session-memory/handler.ts:309`

- Operation: `fs.writeFile()`
- Risk: Hook memory file injection
- Recommendation: Wire if hooks are untrusted

#### 13. **Line Media Download** (LOW)

Location: `src/line/download.ts:44`

- Operation: `fs.promises.writeFile()`
- Risk: Unauthorized media file creation
- Recommendation: Standard asset handling

#### 14. **Browser Profile Decoration** (LOW)

Location: `src/browser/chrome.profile-decoration.ts:30`

- Operation: `fs.writeFileSync()`
- Risk: Chrome profile corruption
- Recommendation: Not critical - read-only operations elsewhere

### Remaining High-Risk Call Sites (Full Audit)

The search revealed 300+ `writeFile` operations. High-risk mutation operations are concentrated in:

1. **Authentication/Credentials** (20+ sites)
   - Auth profiles, device auth, credentials
   - Status: Medium priority for wiring

2. **Configuration** (50+ sites)
   - Config files, includes, plugin configs
   - Status: High priority (some already gated)

3. **Session/State Management** (40+ sites)
   - Session stores, transcripts, cron stores
   - Status: High priority (phase 3 commit points)

4. **Plugin/Extension Management** (30+ sites)
   - Plugin manifest, loader, installation
   - Status: Medium priority

5. **Test Fixtures** (150+ sites)
   - Test setup and teardown operations
   - Status: Low priority (test-only)

6. **Temporary Files** (40+ sites)
   - Media processing, WAV files, temporary caches
   - Status: Low-medium priority

## Wiring Strategy (Phase 4)

### Immediate Priority (Foundation)

**These 3 locations establish the wiring pattern:**

1. ✓ Create `file-system-ops-gating.ts` module (DONE)
2. ✓ Add focused test suite (30 tests passing) (DONE)
3. Add strategic example wiring (ready for implementation):
   - `src/config/io.ts:1236` - configuration boundary
   - `src/cron/store.ts:55-56` - cron job persistence

### Why This Phased Approach

- **Reusable foundation ready:** All wrapper functions created and tested
- **Decision logic in place:** `applyFileSystemOverrides()` routes correctly
- **Execution order validated:** Tests confirm gate runs before fs operation
- **Structured logging ready:** All wrappers log with `FILE_SYSTEM_OPS` ontology
- **Type-safe:** Type guards handle PROCEED vs ABSTAIN outcomes

### Next Step Pattern

When wiring a call site:

```typescript
// OLD
await fs.promises.writeFile(path, data, encoding);

// NEW
import { applyFileSystemOpsGateAndWrite } from "../clarityburst/file-system-ops-gating.js";
await applyFileSystemOpsGateAndWrite(path, data, encoding);
```

This maintains:

- Original parameters unchanged
- Async behavior preserved
- Error semantics (throw ClarityBurstAbstainError on abstention)
- No behavior change when gate approves (PROCEED)

## Test Coverage

### Validation Tests (30/30 passing)

**Abstention Behavior (2 tests)**

- ABSTAIN_CONFIRM blocks without side effect
- ABSTAIN_CLARIFY blocks without side effect

**Approval Behavior (3 tests)**

- PROCEED executes fs operation
- Parameters preserved
- No modification when approved

**Context Extraction (8 tests)**

- Operation types: write, delete, rename, mkdir
- Path handling: absolute, relative, directory paths
- Log context completeness

**Execution Order (3 tests)**

- Gate executes before fs operation
- Gate executes exactly once
- No fs operation on abstain

**Error Properties (2 tests)**

- Correct stageId, outcome, contractId, instructions
- Non-retryable flag set correctly

**Real-World Scenarios (4 tests)**

- Config file blocking
- Delete operation approval
- Rename blocking on uncertainty
- Mkdir with recursive flag

**Operation Classification (5 tests)**

- Mutation operations correctly identified
- Gate routing applies to all

**Logging Context (3 tests)**

- Operation type captured
- Target path captured
- ContractId captured

## Type Safety

All wrappers use TypeScript discriminated unions:

```typescript
function isAbstainOutcome(result: any): result is {
  outcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY";
  reason?: string;
  instructions?: string;
  contractId?: string | null;
} {
  return result && (result.outcome === "ABSTAIN_CONFIRM" || result.outcome === "ABSTAIN_CLARIFY");
}
```

This ensures safe property access and prevents runtime errors from trying to access properties that only exist on ABSTAIN outcomes.

## Logging Format

All wrapped operations log:

```json
{
  "ontology": "FILE_SYSTEM_OPS",
  "contractId": "FS_WRITE_CONFIG",
  "outcome": "PROCEED",
  "operation": "write",
  "path": "/etc/openclaw.json"
}
```

This enables:

- Audit trail filtering by `ontology: FILE_SYSTEM_OPS`
- Contract mapping via `contractId`
- Operation classification via `operation` field
- Affected resource tracking via `path`

## Success Criteria

✓ Reusable wrapper module created and exported
✓ Type-safe implementation with discriminated unions  
✓ Execution order validated (gate → fs operation)
✓ PROCEED allows original behavior unchanged
✓ ABSTAIN outcomes throw before side effect
✓ Structured logging with required fields
✓ 30 focused tests passing
✓ No modifications to reasoning, planning, routing, or tool-selection

## Remaining Work

1. Wire strategic commit points (IO, cron, daemon)
2. Expand to medium-priority sites (auth, plugin management)
3. Audit and wire remaining high-risk operations
4. Integrate with orchestration workflows
5. Add distributed contract mappings for operation types

## References

- `src/clarityburst/file-system-ops-gating.ts` - Wrapper implementations
- `src/clarityburst/__tests__/file_system_ops.gating.simple.test.ts` - Validation tests
- `src/clarityburst/decision-override.ts` - `applyFileSystemOverrides()` routing
- `src/clarityburst/network-io-gating.ts` - NETWORK_IO pattern reference
