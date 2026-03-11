# CRON_SCHEDULE Execution-Boundary Gating Implementation

## Overview

This document describes the CRON_SCHEDULE execution-boundary gating foundation for OpenClaw, built using the same validated wrapper architecture already established for NETWORK_IO, FILE_SYSTEM_OPS, and BROWSER_AUTOMATE.

## Architecture

The implementation follows the established pattern:

```
User Code
    ↓
Gating Wrapper (cron-schedule-gating.ts)
    ↓
ClarityBurst Gate (applyCronScheduleOverrides)
    ├── Router Decision
    ├── Pack Policy Validation
    └── Contract Risk Gating
    ↓
[PROCEED] → Cron Operation
[ABSTAIN_CONFIRM] → Block + Error
[ABSTAIN_CLARIFY] → Block + Error
```

## Files Created

### 1. `src/clarityburst/cron-schedule-gating.ts`

Reusable gating module providing three main wrappers:

- **`applyCronScheduleGateAndAdd(jobCreate, execute, actionType)`**
  - Applies CRON_SCHEDULE gate before job creation
  - Captures schedule info, job name, and task type
  - Throws `ClarityBurstAbstainError` if gate abstains
  - Returns created job if gate approves

- **`applyCronScheduleGateAndUpdate(jobId, patch, execute, actionType)`**
  - Applies CRON_SCHEDULE gate before job update
  - Detects enablement (cron_enable/cron_disable) vs. general update
  - Captures schedule changes and target job ID
  - Throws `ClarityBurstAbstainError` if gate abstains
  - Returns updated job if gate approves

- **`applyCronScheduleGateAndSetEnabled(jobId, enabled, execute)`**
  - Convenience wrapper for enable/disable operations
  - Delegates to `applyCronScheduleGateAndUpdate`
  - Sets taskType to cron_enable/cron_disable appropriately

### 2. `src/clarityburst/__tests__/cron_schedule.gating.simple.test.ts`

Comprehensive test suite with 14 tests covering:

**applyCronScheduleGateAndAdd (5 tests)**

- PROCEED allows original cron action unchanged
- ABSTAIN_CONFIRM blocks before side effect
- ABSTAIN_CLARIFY blocks before side effect
- Captures action type and schedule context correctly
- Execution order: gate → cron side effect

**applyCronScheduleGateAndUpdate (4 tests)**

- PROCEED: update succeeds
- ABSTAIN_CONFIRM: blocks update before side effect
- Captures enablement context correctly
- Detects disable operation

**applyCronScheduleGateAndSetEnabled (2 tests)**

- setEnabled(true) uses enable context
- setEnabled(false) uses disable context

**Error handling and edge cases (3 tests)**

- Propagates non-abstain errors from cron action
- Handles unknown schedule format gracefully
- Handles update with no schedule change

## Wiring Locations

### Gateway Integration

**File: `src/gateway/server-methods/cron.ts`**

#### cron.add handler (lines 91-145)

```typescript
try {
  const job = await applyCronScheduleGateAndAdd(
    jobCreate,
    async (params) => context.cron.add(params),
    "create"
  );
  respond(true, job, undefined);
} catch (err) {
  if (err instanceof ClarityBurstAbstainError) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, ...));
  } else {
    throw err;
  }
}
```

**Execution sequence:**

1. Validate and normalize input (existing)
2. Validate timestamp (existing)
3. **Apply CRON_SCHEDULE gate**
4. Call context.cron.add if gate approves
5. Return result or ClarityBurst error

#### cron.update handler (lines 117-200)

```typescript
try {
  const job = await applyCronScheduleGateAndUpdate(
    jobId,
    patch,
    async (id, p) => context.cron.update(id, p),
    "update"
  );
  respond(true, job, undefined);
} catch (err) {
  if (err instanceof ClarityBurstAbstainError) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, ...));
  } else {
    throw err;
  }
}
```

**Execution sequence:**

1. Validate and normalize patch (existing)
2. Extract job ID (existing)
3. Validate timestamp if schedule provided (existing)
4. **Apply CRON_SCHEDULE gate**
5. Call context.cron.update if gate approves
6. Return result or ClarityBurst error

### Agent Tool Integration

**File: `src/agents/tools/cron-tool.ts`**

The agents cron-tool already delegates to the gateway via `callGateway("cron.add", ...)` and `callGateway("cron.update", ...)`.

**Gating is automatically applied** because the gateway handlers have been wired with the CRON_SCHEDULE gating wrappers.

No direct changes to cron-tool needed—the wrappers are transparently applied at the gateway boundary.

## Context Captured

### CronScheduleContext fields passed to ClarityBurst

```typescript
{
  stageId: "CRON_SCHEDULE",
  userConfirmed: false,
  schedule?: string,           // cron expression, "every N ms", "at ISO timestamp", or undefined
  taskType?: string,           // "cron_create", "cron_update", "cron_enable", "cron_disable"
  target?: string,             // Job name (create) or job ID (update)
}
```

### Logging structure

All operations log with ontology="CRON_SCHEDULE" and include:

- `contractId` from gate decision
- `outcome` (PROCEED, ABSTAIN_CONFIRM, ABSTAIN_CLARIFY)
- `actionType` (create, update, enable, disable)
- `jobName` or `jobId` (target identifier)
- `scheduleSummary` (human-readable schedule representation)

Example log entry:

```json
{
  "ontology": "CRON_SCHEDULE",
  "contractId": "CRON_SCHEDULE_CREATE",
  "outcome": "PROCEED",
  "actionType": "create",
  "jobName": "daily-reminder",
  "scheduleSummary": "0 9 * * MON-FRI @ America/New_York"
}
```

## High-Risk Call Sites Wired

### Initial scope (this implementation)

1. **schedule creation** → `context.cron.add()` wrapped by `applyCronScheduleGateAndAdd`
2. **schedule update** → `context.cron.update()` wrapped by `applyCronScheduleGateAndUpdate`
3. **schedule persistence** → Implicit in cron.add and cron.update (store operations happen after gate approval)
4. **schedule activation** → Implicit in cron.add; explicit enable handled by cron.update with enabled=true

### Remaining high-risk call sites (not yet wired)

1. **schedule deletion** → `context.cron.remove()` (future work)
2. **job registration with dispatcher** → Internal to cron.add; gated implicitly
3. **schedule persistence at startup/reload** → Internal to cron service; separate gating may be needed

## Validation

### Test Coverage

✓ All 14 tests passing  
✓ PROCEED path verified  
✓ ABSTAIN_CONFIRM path verified  
✓ ABSTAIN_CLARIFY path verified  
✓ Execution order verified (gate always before side effect)  
✓ Cron actions never called if gate abstains  
✓ Context captured correctly  
✓ Error propagation verified  
✓ Edge cases handled gracefully  

### Execution Guarantee

The wrapper guarantees:

1. **Gate executes first** — ClarityBurst decision made before any cron side effect
2. **No unauthorized persistence** — If gate abstains, cron action never executes
3. **No partial state** — Job not created/updated until gate approves
4. **Transparent to callers** — If gate approves, result is identical to unwrapped behavior
5. **Type-safe** — Full TypeScript support with proper typing

## Integration Checklist

- [x] Gating module created: `cron-schedule-gating.ts`
- [x] ClarityBurst override function exists and is called: `applyCronScheduleOverrides`
- [x] Gateway cron.add wired (lines 91-145)
- [x] Gateway cron.update wired (lines 117-200)
- [x] Agent cron-tool implicitly gated (via gateway delegation)
- [x] Comprehensive tests created and passing (14/14)
- [x] Structured logging in place
- [x] Error handling (ClarityBurstAbstainError) integrated
- [x] Exports added to `src/clarityburst/index.ts`
- [x] Documentation complete

## Future Enhancements

1. **Schedule deletion gating** — Wire `applyCronScheduleGateAndDelete` into cron.remove
2. **Startup persistence gating** — Gate cron jobs loaded from storage at startup
3. **Scheduled execution gating** — Gate actual cron execution (separate from creation/update)
4. **Job listing gating** — Restrict cron.list results based on capabilities
5. **Metrics integration** — Add runMetrics tracking for CRON_SCHEDULE operations

## References

- ClarityBurst decision override: [`decision-override.ts:applyCronScheduleOverrides`](decision-override.ts:2058)
- NETWORK_IO gating pattern: [`network-io-gating.ts`](network-io-gating.ts)
- FILE_SYSTEM_OPS gating pattern: [`file-system-ops-gating.ts`](file-system-ops-gating.ts)
- BROWSER_AUTOMATE gating pattern: [`browser-automate-gating.ts`](browser-automate-gating.ts)
