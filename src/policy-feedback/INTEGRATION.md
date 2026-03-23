# Policy Feedback Engine: Integration Plan

## Overview

This document specifies the exact files to modify, hook attachment points, and the phased rollout strategy. Each phase is independently deployable and reversible via config.

---

## Phase 1: Passive Observer (Zero Behavior Change)

### Goal

Log actions and outcomes. No decision-making. No code changes to existing dispatch/agent/delivery paths.

### New Files to Create

| File                                 | Purpose                                             |
| ------------------------------------ | --------------------------------------------------- |
| `src/policy-feedback/types.ts`       | All type definitions (interfaces, records, config)  |
| `src/policy-feedback/persistence.ts` | JSONL append, JSON read/write, directory management |
| `src/policy-feedback/ledger.ts`      | Action logging logic                                |
| `src/policy-feedback/outcomes.ts`    | Outcome logging + correlation logic                 |
| `src/policy-feedback/aggregates.ts`  | Aggregate computation from JSONL                    |
| `src/policy-feedback/config.ts`      | Config loading, defaults, env var override          |
| `src/policy-feedback/engine.ts`      | PolicyFeedbackEngine implementation                 |
| `src/policy-feedback/index.ts`       | Public barrel export                                |

### Existing Files to Modify

#### 1. `src/hooks/internal-hooks.ts`

**Change:** None. The internal hook registration API is already public. The policy feedback module calls `registerInternalHook()` from its own initialization code.

#### 2. `src/gateway/server.impl.ts`

**Change:** Add policy feedback engine initialization during gateway startup. This is a single function call added alongside other subsystem initializations (cron, channels, plugins).

**Location:** After plugin loading and before the gateway is marked ready. Look for where `buildGatewayCronService`, `startBackupScheduler`, and `loadGatewayPlugins` are called.

**Modification:**

```typescript
// Add import at top
import { initializePolicyFeedback } from "../policy-feedback/index.js";

// Add initialization call near other subsystem starts
const policyEngine = initializePolicyFeedback({ config: cfg, agentId: defaultAgentId });
```

**Impact:** One import, one function call. The `initializePolicyFeedback` function internally calls `registerInternalHook` for the events it observes. If config mode is `"off"`, it returns a no-op engine.

#### 3. `src/config/types.ts` (add new type export)

**Change:** Add `export * from "./types.policy-feedback.js"` to the barrel export.

**New file:** `src/config/types.policy-feedback.ts` containing the `PolicyFeedbackConfig` type that integrates into `OpenClawConfig`.

**Impact:** Adds the `policyFeedback?` optional field to the config type. No runtime behavior change.

### Hook Attachments for Action Logging

#### Internal Hook: `message:received`

**What it logs:** Every inbound message as a potential action trigger.

**Registration:** Called from `initializePolicyFeedback()`:

```typescript
registerInternalHook("message:received", async (event) => {
  // Extract: from, channelId, sessionKey, timestamp, conversationId
  // Create a pending action record (awaiting agent_end to confirm action was taken)
  // Write to a pending-actions in-memory map (keyed by sessionKey)
});
```

**Why here:** This is the earliest point where we know a message arrived. It creates a "pending" entry that gets promoted to a full action record when the agent responds.

#### Internal Hook: `message:sent`

**What it logs:** Every outbound message as a confirmed action + immediate delivery outcome.

**Registration:**

```typescript
registerInternalHook("message:sent", async (event) => {
  // Extract: to, content, success, channelId, sessionKey, timestamp
  // 1. Promote pending action to confirmed action (actionType: "agent_reply")
  // 2. Log immediate outcome (delivery_success or delivery_failure)
  // 3. Append ActionRecord to actions.jsonl
  // 4. Append OutcomeRecord to outcomes.jsonl
});
```

**Why here:** This confirms that the system actually acted (sent a message), and gives us the immediate delivery outcome.

### Hook Attachments for Outcome Logging

#### Delayed Outcome Correlation (on `message:received`)

The `message:received` handler has a second responsibility: correlating user replies with prior agent actions.

```typescript
registerInternalHook("message:received", async (event) => {
  // In addition to logging the inbound message...
  // Look up recent uncorrelated outbound actions for this session
  // For each uncorrelated action within the outcome horizons:
  //   - Compute response latency (now - action timestamp)
  //   - Log OutcomeRecord with outcomeType: "user_replied", horizonMs, value (latency)
  //   - Mark the action as correlated
});
```

**Why here:** The arrival of a new user message is the natural trigger for observing that the user responded to a prior agent action. This is the "delayed outcome" mechanism for V1.

#### Silence Detection (periodic check)

For detecting `user_silent` outcomes (the user did NOT reply), a periodic check is needed:

**Option A (preferred for V1):** Piggyback on the aggregate recomputation cron job. When computing aggregates, scan for actions that have no `user_replied` outcome after the longest configured horizon. Log `user_silent` outcomes for those.

**Option B (V2):** Register a dedicated cron job that runs every N minutes and checks for uncorrelated actions past their horizon.

---

## Phase 2: Advisory Ranker (Soft Influence, No Hard Control)

### Additional New Files

| File                                 | Purpose                    |
| ------------------------------------ | -------------------------- |
| `src/policy-feedback/ranker.ts`      | Candidate scoring logic    |
| `src/policy-feedback/constraints.ts` | Constraint rule evaluation |

### Existing Files to Modify

#### 1. `src/plugins/hook-runner-global.ts` (or equivalent plugin hook registration)

**Change:** Register a plugin hook handler for `before_agent_start` that injects policy hints into the agent context.

**Approach:** The policy feedback engine exposes a method that the gateway startup code uses to register the plugin hook. This avoids the policy module directly depending on plugin internals.

```typescript
// In server.impl.ts, after plugin loading:
if (policyEngine.getStatus().mode === "advisory" || policyEngine.getStatus().mode === "active") {
  hookRunner.on("before_agent_start", async (ctx) => {
    const hints = await policyEngine.getPolicyHints({
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      channelId: ctx.channelId,
    });
    if (hints.recommendation !== "proceed") {
      // Append policy hints to system prompt additions
      ctx.systemPromptAdditions = ctx.systemPromptAdditions ?? [];
      ctx.systemPromptAdditions.push(formatPolicyHintsForPrompt(hints));
    }
  });
}
```

**Impact:** In advisory mode, the LLM receives additional context about policy recommendations. It can choose to follow or ignore them. No hard suppression.

**Note:** The exact API for modifying the agent's system prompt via `before_agent_start` needs to be verified against the actual hook context type. If the hook does not support prompt modification, an alternative is to use `before_prompt_build` or `llm_input`.

#### 2. `src/auto-reply/reply/get-reply.ts`

**Change (minimal):** No change needed if prompt injection works via hooks. If hook-based prompt injection is insufficient, a small integration point here would pass policy hints into the agent's directive/instruction assembly.

**Impact:** Zero to minimal. Advisory hints are suggestions, not commands.

---

## Phase 3: Active Policy Gate (Hard Control)

### Existing Files to Modify

#### 1. `src/auto-reply/reply/dispatch-from-config.ts`

**Change:** Add a policy gate check after duplicate detection but before `getReplyFromConfig()` is called.

**Location in `dispatchReplyFromConfig()`:** After the `shouldSkipDuplicateInbound` check (line ~185) and before the main processing begins.

```typescript
// After duplicate check, before main processing:
if (policyEngine && policyEngine.getStatus().mode === "active") {
  try {
    const hints = await policyEngine.getPolicyHints({
      agentId: resolveSessionAgentId({ sessionKey, config: cfg }),
      sessionKey: sessionKey ?? "",
      channelId: channel,
    });
    if (hints.recommendation === "suppress") {
      // Log the suppression as an action
      await policyEngine.logAction({
        agentId: hints.agentId,
        sessionKey: sessionKey ?? "",
        actionType: "suppressed",
        channelId: channel,
        rationale: hints.reasons.join("; "),
      });
      recordProcessed("skipped", { reason: "policy_suppressed" });
      return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
    }
  } catch {
    // Fail open: if policy check fails, proceed normally
  }
}
```

**Impact:** Only active when `mode === "active"`. Fail-open on errors. Logged as a processed-skipped event using existing diagnostic patterns.

#### 2. Plugin Hook: `before_tool_call`

**Change:** Register a plugin hook that can suppress individual tool calls.

```typescript
hookRunner.on("before_tool_call", async (ctx) => {
  if (policyEngine.getStatus().mode !== "active") return;

  const result = await policyEngine.evaluateToolCall({
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    toolName: ctx.toolName,
    channelId: ctx.channelId,
  });

  if (result.suppress) {
    // Return a signal to skip the tool call
    // (depends on how before_tool_call supports cancellation)
    ctx.skip = true;
    ctx.skipReason = result.reason;
  }
});
```

**Note:** The exact mechanism for suppressing a tool call via `before_tool_call` needs verification. If the hook does not support cancellation, this integration point would need a small change to the tool execution path.

---

## Ensuring Zero Behavior Change in Passive Mode

### Verification Checklist

1. **No imports in hot paths.** The policy feedback module is imported only in `server.impl.ts` during gateway startup. It is not imported in `dispatch-from-config.ts`, `get-reply.ts`, or any agent/delivery code.

2. **Hook handlers are fire-and-forget.** All internal hook handlers use async functions that append to files. Errors are caught and logged. They do not return values that affect the calling code.

3. **No conditional logic in existing code.** Phase 1 adds no `if (policyEnabled)` checks to existing dispatch or agent code. The only modification is the initialization call in `server.impl.ts`.

4. **Config field is optional.** The `policyFeedback?` field in `OpenClawConfig` is optional with defaults. Existing configs without this field behave identically.

5. **File I/O is isolated.** All writes go to `~/.openclaw/policy-feedback/`, a new directory that does not conflict with any existing data.

6. **No new dependencies.** The module uses only `node:fs`, `node:path`, `node:crypto` (for UUID generation), and existing internal utilities (`createSubsystemLogger`, `resolveStateDir`, `registerInternalHook`).

7. **Performance budget.** Each hook handler does one `fs.appendFile` call (non-blocking, fire-and-forget). Measured overhead target: less than 1ms per message event on the main thread (file I/O is offloaded to the Node.js thread pool).

### Test Plan for Zero Regression

```
# Existing dispatch tests must pass unchanged
pnpm test -- src/auto-reply/reply/dispatch-from-config.test.ts

# Existing hook tests must pass unchanged
pnpm test -- src/hooks/

# New policy feedback tests (isolated)
pnpm test -- src/policy-feedback/

# Full suite (confirm no collateral damage)
pnpm test
```

---

## Integration Dependency Graph

```
Phase 1 (no dependencies on existing code changes):
  src/policy-feedback/* (new module)
  src/gateway/server.impl.ts (one init call)
  src/config/types.ts (one type export)

Phase 2 (depends on Phase 1):
  src/policy-feedback/ranker.ts (new)
  src/policy-feedback/constraints.ts (new)
  src/gateway/server.impl.ts (hook registration)
  [possibly] src/plugins/hook-runner-global.ts (verify before_agent_start API)

Phase 3 (depends on Phase 2):
  src/auto-reply/reply/dispatch-from-config.ts (gate check)
  src/gateway/server.impl.ts (tool call hook registration)
```

---

## Rollback Plan

Each phase can be independently disabled:

- **Disable all:** Set `policyFeedback.mode: "off"` in config or `OPENCLAW_POLICY_FEEDBACK_MODE=off` env var. The `initializePolicyFeedback` function returns a no-op engine. No hooks are registered.
- **Revert to passive:** Set mode to `"passive"`. Advisory and active code paths are not entered.
- **Full removal:** Remove the `initializePolicyFeedback` call from `server.impl.ts` and the type export from `config/types.ts`. Delete `src/policy-feedback/`. Delete `~/.openclaw/policy-feedback/`.

---

## Summary of Files Modified by Phase

| Phase | File                                           | Change Type            | Lines Changed (est.) |
| ----- | ---------------------------------------------- | ---------------------- | -------------------- |
| 1     | `src/gateway/server.impl.ts`                   | Add import + init call | 3                    |
| 1     | `src/config/types.ts`                          | Add export line        | 1                    |
| 1     | `src/config/types.policy-feedback.ts`          | New file (config type) | ~30                  |
| 2     | `src/gateway/server.impl.ts`                   | Add hook registration  | ~15                  |
| 3     | `src/auto-reply/reply/dispatch-from-config.ts` | Add policy gate        | ~20                  |
| 3     | `src/gateway/server.impl.ts`                   | Add tool call hook     | ~15                  |
