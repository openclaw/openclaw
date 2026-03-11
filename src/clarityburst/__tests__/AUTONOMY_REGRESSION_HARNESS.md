# ClarityBurst Autonomy Regression Validation Harness

## Overview

The autonomy regression validation harness is a focused testing framework that validates OpenClaw's autonomous agent behavior remains performant under conditions where ClarityBurst's decision system returns `PROCEED` for all required actions. It records comprehensive metrics, detects regressions, and reports outcome quality without modifying runtime behavior or gating policies.

**Key Principle**: This harness is purely observational. It records metrics, compares against baselines, and reports findings without changing how OpenClaw actually executes.

## Architecture

### Three Core Modules

1. **`autonomy.regression.harness.ts`** – Core metrics and regression analysis
   - `WorkflowRunMetrics`: Captures all runtime data for a single workflow execution
   - `RegressionFinding`: Identified regression with severity and recommendation
   - `analyzeWorkflowRegression()`: Compares current run against baseline
   - `generateRegressionReport()`: Produces human-readable regression report

2. **`autonomy.regression.baseline.ts`** – Baseline persistence and management
   - Stores baselines in `~/.openclaw/autonomy-regression-baselines/`
   - `loadBaseline()`: Retrieves existing baseline from disk
   - `saveBaseline()`: Persists new or updated baseline
   - `getOrCreateBaseline()`: Creates first-run baseline automatically
   - `exportAllBaselines()`: Bulk export for CI/CD reporting

3. **`autonomy.regression.harness.test.ts`** – Workflow test suite and regression detection
   - Five representative workflows (FileSystem, Memory, Shell, Network, Subagent)
   - Each workflow runs end-to-end with all `PROCEED` decisions
   - Tests validate tool path continuity, latency, completion, and semantic output

### Metrics Tracked Per Workflow

For each workflow execution, the harness records:

| Metric | Type | Purpose |
|--------|------|---------|
| `completed` | boolean | Did workflow finish without exception? |
| `totalLatencyMs` | number | Total elapsed time in milliseconds |
| `toolInvocations` | number | Count of tool/operation calls |
| `proceedCount` | number | Count of `PROCEED` routing decisions |
| `abstainClarifyCount` | number | Count of `ABSTAIN_CLARIFY` (should be 0 in baseline) |
| `abstainConfirmCount` | number | Count of `ABSTAIN_CONFIRM` (should be 0 in baseline) |
| `retries` | number | Count of retry attempts |
| `toolPath` | ToolPathPoint[] | Ordered sequence of tool invocations with outcomes |
| `semanticValidation` | object | Output quality check (e.g., file contents match expected) |

### Baseline Recording

**First Run**: When a workflow has no baseline on disk:

1. Workflow executes normally
2. Metrics recorded at workflow completion
3. `createBaselineFromRun()` generates baseline from metrics
4. `saveBaseline()` persists to `~/.openclaw/autonomy-regression-baselines/{workflowId}.baseline.json`

**Subsequent Runs**: When baseline exists:

1. Workflow executes and records metrics
2. `analyzeWorkflowRegression()` compares against baseline
3. Findings generated for any regressions detected
4. Optional: `updateBaselineWithRun()` refines baseline with new data (averaging latency, tool counts, etc.)

### Regression Detection

The harness detects five categories of regressions:

#### 1. **Latency Degradation**

- Compares total workflow latency against baseline average
- `WARNING`: 10%+ degradation (configurable)
- `CRITICAL`: 25%+ degradation (configurable)
- Example: Baseline 100ms → Current 150ms = 50% increase = `CRITICAL`

#### 2. **Tool Path Continuity**

- Validates tool invocation order matches baseline
- `CRITICAL` if order changes (indicates workflow structure changed)
- Captures both stage ID and tool name
- Example: Expected `[writeFile→readFile→writeFile]` but got `[writeFile→writeFile→readFile]` = `CRITICAL`

#### 3. **Tool Invocation Count**

- Exact match required when `strictToolPathMatching` enabled
- `WARNING` if count differs from baseline
- Example: Baseline 5 tools → Current 6 tools = `WARNING`

#### 4. **Abstain/Confirm Counts**

- Baselines establish expected abstain counts (typically 0)
- `WARNING` if any abstains occur when baseline had none
- Indicates gating decisions changed
- Example: Baseline 0 ABSTAIN → Current 1 ABSTAIN = `WARNING`

#### 5. **Semantic Validation Failure**

- Baseline records if semantic validation must pass
- `CRITICAL` if output quality checks fail
- Example: File contents don't match expected format = `CRITICAL`

### Regression Report

Reports include:

```
═══════════════════════════════════════════════════════════════
ClarityBurst Autonomy Regression Validation Report
═══════════════════════════════════════════════════════════════

Summary: ✗ Autonomy regression detected. Health score: 70/100. Found 2 regression(s).
Health Score: 70/100
Generated: 2026-03-11T03:00:00.000Z

REGRESSIONS DETECTED:
───────────────────────────────────────────────────────────────

[CRITICAL] 1 critical issue(s):
  • FileSystemOpsWorkflow / toolPathContinuity
    Baseline: 5, Current: 4 (Δ -1, -20.0%)
    → Tool path order changed in FileSystemOpsWorkflow. This indicates a fundamental workflow regression...

[WARNING] 1 warning(s):
  • NetworkIOWorkflow / totalLatencyMs
    Baseline: 150, Current: 200 (Δ 50, 33.3%)
    → NetworkIOWorkflow latency increased by 33.3%. Monitor for further degradation.
```

Health score calculation:

- Start: 100
- Per `CRITICAL`: -25
- Per `WARNING`: -10
- Per `INFO`: -2
- Minimum: 0

## Workflow Suite

### 1. FileSystemOpsWorkflow

**Purpose**: Validates sequential file operations with gating intact

**Steps**:

1. `ensureDir` (input directory)
2. `ensureDir` (output directory)
3. `writeFile` (input.json with deterministic data)
4. `readFile` (input.json)
5. `writeFile` (output.md with transformed data)

**Expected Outcomes**: 5 tool invocations, all `PROCEED`, ~30-50ms latency

**Semantic Validation**: Output file exists, contains expected markdown format

---

### 2. MemoryModifyWorkflow

**Purpose**: Validates session memory updates and hook handler execution

**Steps**:

1. `updateMemory` (append messages to session)
2. `callHook` (trigger hook handler for side effects)
3. `readMemory` (verify state consistency)

**Expected Outcomes**: 3 tool invocations, all `PROCEED`, ~20-30ms latency

**Semantic Validation**: Memory has correct message count and context updated by hook

---

### 3. ShellExecWorkflow

**Purpose**: Validates shell command execution with confirmation token validation

**Steps**:

1. `validateCommand` (compute command hash)
2. `checkToken` (verify confirmation token matches hash)
3. `executeCommand` (run shell command if token valid)

**Expected Outcomes**: 3 tool invocations, all `PROCEED`, ~20-40ms latency

**Semantic Validation**: Command output contains expected string

---

### 4. NetworkIOWorkflow

**Purpose**: Validates network operation gating (mocked to avoid external dependencies)

**Steps**:

1. `validateUrl` (check HTTPS)
2. `checkRateLimit` (verify rate limit not exceeded)
3. `executeFetch` (simulated fetch with realistic latency)
4. `parseResponse` (JSON parsing)

**Expected Outcomes**: 4 tool invocations, all `PROCEED`, ~50-100ms latency (includes simulated network delay)

**Semantic Validation**: Response contains expected fields and values

---

### 5. SubagentSpawnWorkflow

**Purpose**: Validates subagent lifecycle and communication patterns

**Steps**:

1. `spawnAgent` (create subagent instance)
2. `sendMessage` (send work request)
3. `waitResponse` (wait for subagent result)
4. `collectResult` (aggregate output)

**Expected Outcomes**: 4 tool invocations, all `PROCEED`, ~50-100ms latency (includes simulated wait)

**Semantic Validation**: Result status is "completed" and output is valid

## Non-Invasiveness

This harness is **purely observational** and does not:

- ✅ Modify ClarityBurst decision logic
- ✅ Intercept gating calls
- ✅ Change router behavior
- ✅ Mock ClarityBurst functions
- ✅ Inject test configuration into production paths
- ✅ Enable/disable features based on test mode
- ✅ Add overhead to production code

The harness:

- Records metrics in isolated test workflows
- Compares metrics against stored baselines
- Reports findings to stdout or files
- Does not affect live OpenClaw agent execution

## Usage

### Run Harness Tests

```bash
pnpm test src/clarityburst/__tests__/autonomy.regression.harness.test.ts
```

### First-Run Baseline Creation

On first run, the harness automatically creates baselines in `~/.openclaw/autonomy-regression-baselines/`:

```
workflow-fs-ops.baseline.json
workflow-memory.baseline.json
workflow-shell.baseline.json
workflow-network.baseline.json
workflow-subagent.baseline.json
```

### View Baselines

```bash
cat ~/.openclaw/autonomy-regression-baselines/workflow-fs-ops.baseline.json
```

### Export All Baselines (for CI/CD)

```typescript
import { exportAllBaselines } from './autonomy.regression.baseline';
const allBaselines = exportAllBaselines();
console.log(JSON.stringify(allBaselines, null, 2));
```

### Reset Baselines (for recalibration)

```typescript
import { resetAllBaselines } from './autonomy.regression.baseline';
resetAllBaselines();
// Next test run will create fresh baselines
```

## Configuration

Regression detection thresholds are configurable via `RegressionHarnessConfig`:

```typescript
const config = createDefaultHarnessConfig();
config.latencyDegradationThresholdPct = 10;  // WARNING at 10%
config.latencyDegradationCriticalPct = 25;  // CRITICAL at 25%
config.strictToolPathMatching = true;        // Exact tool sequence required
config.retryVarianceThresholdPct = 50;       // Allow 50% variance in retries
config.semanticValidationRequired = true;    // Output quality must pass
config.toolPathContinuityRequired = true;    // Order must match baseline
```

## Integration with CI/CD

The harness can be integrated into CI pipelines:

```bash
# Run harness and capture report
pnpm test src/clarityburst/__tests__/autonomy.regression.harness.test.ts --run

# Exit code 0: All tests passed (no regressions)
# Exit code 1: Tests failed (regression detected)
```

Export baseline data for comparison across builds:

```bash
# In CI script
pnpm test autonomy.regression.harness.test.ts
BASELINE_JSON=$(node -e "console.log(JSON.stringify(require('./autonomy.regression.baseline').exportAllBaselines()))")
echo "BASELINE=$BASELINE_JSON" >> $GITHUB_ENV
```

## Expected Baseline Metrics

Reference values (from successful runs):

| Workflow | Latency | Tools | Retries | Abstrains | Completion |
|----------|---------|-------|---------|-----------|------------|
| FileSystem | 30-50ms | 5 | 0 | 0 | 100% |
| Memory | 20-30ms | 3 | 0 | 0 | 100% |
| Shell | 20-40ms | 3 | 0 | 0 | 100% |
| Network | 50-100ms | 4 | 0 | 0 | 100% |
| Subagent | 50-100ms | 4 | 0 | 0 | 100% |

Regressions are detected when current metrics exceed thresholds above baseline.

## Troubleshooting

### "Baseline not found for workflow X"

**Cause**: First run; baseline not yet created  
**Solution**: Normal on first execution. Baseline will be created automatically.

### "Tool path order changed"

**Cause**: Gating or routing decisions altered workflow structure  
**Solution**:

- Verify no changes to gating contracts or router
- If intentional improvement, reset baseline: `resetAllBaselines()`

### "Latency increased significantly"

**Cause**: Performance regression, additional retries, or I/O blocking  
**Solution**:

- Check for new logging or tracing overhead
- Verify no additional network calls
- Profile with `--prof` flag if baseline still valid

### "Semantic validation failed"

**Cause**: Workflow output format changed  
**Solution**:

- Verify transform logic and data mapping
- Check for changes to field names or ordering
- Update semantic validation checks if intentional

## See Also

- [`src/clarityburst/run-metrics.ts`](../run-metrics.ts:1) – Per-run metrics definitions
- [`src/clarityburst/__tests__/multi_step_autonomy.e2e.test.ts`](./multi_step_autonomy.e2e.test.ts:1) – End-to-end autonomy testing
- [`clarityburst-docs/validation/VERIFICATION_HARNESS.md`](../../../clarityburst-docs/validation/VERIFICATION_HARNESS.md:1) – Chaos and security harness reference
