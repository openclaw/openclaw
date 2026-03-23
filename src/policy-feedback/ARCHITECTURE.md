# Policy Feedback Engine: Architecture

## Overview

The policy feedback subsystem is a bundled internal module at `src/policy-feedback/` that observes agent actions and user outcomes, computes effectiveness statistics, and provides scoring/ranking guidance for future actions. It follows the same organizational pattern as `src/memory/` and `src/cron/`.

The subsystem operates in four modes: **off** (disabled), **passive** (observe-only), **advisory** (scoring + prompt hints), and **active** (hard suppress/allow gates).

---

## Module Map

| File             | Purpose                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `types.ts`       | All type definitions: records, config, engine interface, scoring types, constraints           |
| `engine.ts`      | `PolicyFeedbackEngineImpl` -- orchestrates all components; implements `PolicyFeedbackEngine`  |
| `ledger.ts`      | `ActionLedger` -- append-only action logging with feature-flag gating and query helpers       |
| `outcomes.ts`    | `OutcomeTracker` -- outcome logging linked to prior actions, with correlation queries         |
| `ranker.ts`      | `CandidateRanker` -- composite scoring heuristic (effectiveness, fatigue, time-of-day, risk)  |
| `constraints.ts` | `ConstraintLayer` -- built-in + custom constraint rules (max nudges, ignores, cooldown, etc.) |
| `aggregates.ts`  | `AggregateComputer` -- full recompute + incremental update of effectiveness statistics        |
| `persistence.ts` | JSONL append, JSON read/write, directory management, path resolution                          |
| `config.ts`      | Config loading, saving, merging, per-agent overrides, feature flags derived from mode         |
| `hooks.ts`       | Internal hook bridge -- registers `message:received`/`message:sent` handlers                  |
| `init.ts`        | High-level `initializePolicyFeedback()` for gateway startup                                   |
| `index.ts`       | Public barrel export                                                                          |

### Test files

| File                    | Coverage                                                    |
| ----------------------- | ----------------------------------------------------------- |
| `engine.test.ts`        | Engine lifecycle, logAction, logOutcome, ranking, status    |
| `observability.test.ts` | getDebugInfo, getStatus, explainScore, getRecentHistory     |
| `integration.test.ts`   | Hook registration, passive mode, failure isolation, cleanup |
| `ledger.test.ts`        | Action logging, querying, feature-flag gating               |
| `outcomes.test.ts`      | Outcome logging, correlation queries                        |
| `ranker.test.ts`        | Scoring factors, ranking order, advisory mode notes         |
| `constraints.test.ts`   | Individual constraint functions, ConstraintLayer pipeline   |
| `aggregates.test.ts`    | Full recompute, incremental update, computeFromRecords      |
| `persistence.test.ts`   | JSONL append/read, JSON read/write, directory creation      |
| `config.test.ts`        | Config loading, merging, env override, per-agent resolution |

---

## Data Flow

```
                    INBOUND MESSAGE
                          |
                          v
              +------------------------+
              | dispatch-from-config   |
              | (routing, dedup, etc.) |
              +------------------------+
                     |         |
           [active]  |         | [passive/advisory]
        +------------+         +---> registerInternalHook('message:received')
        |                                   |
        v                                   v
  +------------------+              +------------------+
  | Policy Gate      |              | Action Logger    |
  | (suppress/allow) |              | (append JSONL)   |
  +------------------+              +------------------+
        |
        v
  +------------------+
  | get-reply.ts     |
  | (resolve agent)  |
  +------------------+
        |
  [advisory] before_agent_start -> inject policy hints into prompt
        |
        v
  +------------------+
  | Agent Runner     |
  | (LLM + tools)    |
  +------------------+
    |           |
    |    before_tool_call / after_tool_call
    v
  +------------------+
  | Outbound Deliver |
  +------------------+
        |
        v
  registerInternalHook('message:sent') --> Outcome Logger (JSONL)
  plugin hook 'agent_end'              --> Agent Run Logger (JSONL)
        |
        v
  +---------------------------+
  | Periodic Aggregate Update |
  | Read JSONL -> compute     |
  | -> write aggregates.json  |
  +---------------------------+
        |
        v
  +---------------------------+
  | Policy Hints / Rankings   |
  +---------------------------+
```

---

## Persistence Layout

```
~/.openclaw/policy-feedback/
  actions.jsonl          # Append-only action log (all agents)
  outcomes.jsonl         # Append-only outcome log (all agents)
  aggregates.json        # Materialized aggregate stats
  policy-config.json     # Optional runtime policy config overrides
  agents/
    <agentId>/
      actions.jsonl      # Per-agent action log (when perAgentScoping=true)
      outcomes.jsonl     # Per-agent outcome log
      aggregates.json    # Per-agent aggregates
```

---

## Usage Examples

### Initialize at gateway startup

```ts
import { initializePolicyFeedback } from "./policy-feedback/init.js";

const handle = await initializePolicyFeedback({
  agentId: "my-agent",
  mode: "passive", // or omit to use config/env
});

// Later, at shutdown:
handle.shutdown();
```

### Create engine directly and log actions

```ts
import { createPolicyFeedbackEngine } from "./policy-feedback/engine.js";

const engine = await createPolicyFeedbackEngine({
  agentId: "agent-1",
  config: { mode: "advisory" },
});

// Log an action
const { actionId } = await engine.logAction({
  agentId: "agent-1",
  sessionKey: "sess-1",
  actionType: "agent_reply",
  channelId: "telegram",
});

// Log an outcome
await engine.logOutcome({
  actionId,
  agentId: "agent-1",
  outcomeType: "user_replied",
  value: 1,
});
```

### Rank candidates

```ts
const ranked = await engine.rankCandidates({
  agentId: "agent-1",
  sessionKey: "sess-1",
  candidates: [
    { id: "reply", actionType: "agent_reply" },
    { id: "noop", actionType: "no_op" },
  ],
  context: { channelId: "telegram", hourOfDay: 14 },
});

for (const candidate of ranked) {
  console.log(`${candidate.candidate.id}: ${candidate.score} (suppress=${candidate.suppress})`);
}
```

### Debug and inspect

```ts
// Engine status
const status = engine.getStatus();
console.log(`Mode: ${status.mode}, Actions: ${status.actionLogSize}`);

// Full debug info
const debug = engine.getDebugInfo();
console.log(`Feature flags:`, debug.featureFlags);
console.log(`Active constraints:`, debug.activeConstraints);

// Explain a specific score
const breakdown = await engine.explainScore("candidate-1", {
  channelId: "telegram",
  recentActionCount: 3,
});
if (breakdown) {
  for (const factor of breakdown.factors) {
    console.log(`  ${factor.name}: ${factor.value} -- ${factor.description}`);
  }
}

// Recent history for debugging
const history = await engine.getRecentHistory("agent-1", 10);
for (const entry of history) {
  console.log(`Action ${entry.action.id} (${entry.action.actionType}):`);
  for (const outcome of entry.outcomes) {
    console.log(`  -> ${outcome.outcomeType}`);
  }
}
```

---

## Key Design Decisions

- **JSONL over SQLite for V1**: Append-only matches the write pattern; no schema migrations; easy to inspect and replay. SQLite can be adopted in V2 if query complexity warrants it.
- **Bundled module, not a plugin**: Core subsystem needing deep access to internal types; ships with every gateway instance.
- **Fail-open**: All public methods are error-safe (never throw). Errors are logged and the engine degrades gracefully.
- **Progressive activation**: Phase 1 (passive) adds zero code changes to dispatch/agent paths. Phase 2 (advisory) injects prompt hints. Phase 3 (active) adds a gate check.
- **Structured logging**: Uses `createSubsystemLogger("policy-feedback")` for all debug/warn output, keeping production logs clean while providing detailed trace data when enabled.
