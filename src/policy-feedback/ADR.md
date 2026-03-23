# ADR: Adaptive Policy Feedback Subsystem

- **Status:** Accepted
- **Date:** 2026-03-23
- **Authors:** dhanoosh (design), implementation via feat/adaptive-policy-subsystem

## Context

OpenClaw agents make decisions turn-by-turn using LLM reasoning, but have no mechanism to learn from the downstream consequences of past actions. The same action that works well in one context (time of day, channel, user engagement level) may be counterproductive in another. Without feedback loops, the system cannot:

- Suppress actions after repeated user ignores
- Learn which action types are effective per channel or time window
- Enforce rate limits, cooldown periods, or fatigue-based constraints
- Prefer silence when confidence is low or risk is high

The design document (`project_plan/dhanoosh.md`) specifies an internal policy/meta-control layer inspired by the concept that agent actions should leave durable traces and that future actions should be shaped by delayed outcomes. The design explicitly requires: no new heavy infrastructure, no deep RL, no LLM-based scoring, reuse of existing persistence patterns, and a phased rollout from passive observation to active intervention.

## Decision

Introduce a self-contained `src/policy-feedback/` subsystem that implements Phases 0-3 of the design doc roadmap:

1. **Passive observer** -- log meaningful actions and available outcomes to append-only JSONL files
2. **Advisory ranker** -- score candidate actions using a composite heuristic; return ranked candidates with reasons
3. **Policy influence** -- enforce suppression rules, rate limits, and constraint layers that gate action execution
4. **Maintenance** -- periodic aggregate recomputation and log retention pruning

### Architecture choices

| Decision                                         | Rationale                                                                                                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JSONL persistence** (not SQLite/Postgres)      | Fits OpenClaw's existing file-based state model (`~/.openclaw/`). Zero new dependencies. Append-only writes are crash-safe. Streaming reads via readline keep memory bounded for large files.                  |
| **Composite heuristic scoring** (not ML/bandits) | Design doc explicitly prohibits deep RL and bandit optimization for V1. A 5-factor weighted heuristic (historical effectiveness, fatigue, time-of-day, recency, risk) is interpretable, testable, and tunable. |
| **Internal hook bridge** (not plugin)            | The subsystem must observe all message:received/message:sent events. OpenClaw's internal hook system provides this without plugin overhead or cross-package imports.                                           |
| **Four operating modes**                         | `off` (disabled), `passive` (logging only), `advisory` (scoring + hints), `active` (hard suppress/allow). This enables the design doc's "advisory-first rollout" requirement.                                  |
| **Per-agent scoping**                            | Action and outcome logs are stored per-agent (`agents/<agentId>/`) by default, enabling independent policy adaptation for multi-agent deployments.                                                             |
| **Home-directory-relative storage**              | All paths resolve from `os.homedir()` through `~/.openclaw/policy-feedback/`. The engine accepts a `home` parameter (not a pre-resolved storage path) to avoid path double-nesting.                            |

### Module structure

```
src/policy-feedback/
  types.ts          -- Data model, engine interface, all type definitions
  engine.ts         -- PolicyFeedbackEngineImpl (composes all components)
  ledger.ts         -- ActionLedger (append-only action logging)
  outcomes.ts       -- OutcomeTracker (outcome logging + correlation)
  ranker.ts         -- CandidateRanker (5-factor composite scoring)
  constraints.ts    -- ConstraintLayer (built-in + custom constraint rules)
  aggregates.ts     -- AggregateComputer (full recompute + incremental)
  persistence.ts    -- JSONL/JSON I/O, path resolution, log retention
  config.ts         -- Config loading, merging, env var override
  hooks.ts          -- Internal hook bridge (message:received/sent)
  init.ts           -- Gateway startup initialization + maintenance timer
  index.ts          -- Public barrel export
```

### Data flow

```
message:received (internal hook)
  -> pendingActions map (keyed by sessionKey)

message:sent (internal hook)
  -> engine.logAction() -> ActionLedger -> JSONL append
  -> engine.logOutcome(delivery_success/failure)
  -> recentConfirmedActions map (for delayed correlation)

next message:received
  -> correlate with prior agent actions
  -> engine.logOutcome(user_replied) with latency-based value

periodic maintenance timer
  -> engine.recomputeAggregates() (full JSONL scan)
  -> pruneOldRecords(retentionDays) (filter + rewrite)
```

### Scoring model

Each candidate action is scored on a 0-100 internal scale (normalized to 0-1):

| Factor                   | Range     | Description                                             |
| ------------------------ | --------- | ------------------------------------------------------- |
| Base score               | 50        | Starting point for all candidates                       |
| Historical effectiveness | +/- 20    | Reply rate for this action type vs neutral (0.5)        |
| Intervention fatigue     | -0 to -25 | Penalty per recent action in 6-hour window              |
| Time-of-day              | +/- 10    | Deviation from average hourly reply rate                |
| Recency                  | -0 to -15 | Penalty for repeated same-type actions in 24h           |
| Risk                     | -0 to -10 | Penalty when low overall effectiveness + low confidence |

Candidates scoring below 30 (configurable) are flagged for suppression.

### Constraint rules (built-in)

| Constraint            | Default        | Behavior                               |
| --------------------- | -------------- | -------------------------------------- |
| Max nudges per day    | 20             | Suppress all candidates if exceeded    |
| Repeated ignores      | 3 consecutive  | Suppress user-facing action types      |
| Cooldown period       | 1 hour         | Suppress if last action was too recent |
| Uncertainty threshold | 0.2 confidence | Suppress non-no-op when data is sparse |

Custom constraints can be added via config with `ConstraintRule` definitions.

### Gateway integration

```typescript
// src/gateway/server.impl.ts (lazy-loaded, non-critical)
void import("../policy-feedback/init.js")
  .then(({ initializePolicyFeedback }) => initializePolicyFeedback({ agentId: defaultAgentId }))
  .then((handle) => {
    policyFeedbackShutdown = handle.shutdown;
  })
  .catch(() => {});
```

The subsystem is dynamically imported and fully isolated. Failures never propagate to the gateway. Shutdown cleanup is registered for hook unsubscription and timer cancellation.

## Consequences

### Positive

- **Zero new dependencies** -- uses Node built-ins (fs, readline, crypto) and existing internal hook system
- **Safe rollout** -- passive mode logs without behavior change; advisory adds scoring without enforcement
- **Observable** -- `getDebugInfo()`, `explainScore()`, `getRecentHistory()`, and structured logging provide full introspection
- **Testable** -- 199 tests across 10 test files; pure scoring functions are independently testable
- **Minimal churn** -- 12 new files in a self-contained directory; 12 lines added to `server.impl.ts`
- **Extensible** -- `PolicyContext.extensions` field for V2 context signals; `RankingWeights` for tuning; custom `ConstraintRule` definitions

### Negative

- **No real-time sequence modeling** -- the heuristic approach cannot capture complex temporal patterns (deferred to Phase 4+)
- **Full-file rewrite on pruning** -- `pruneOldRecords` reads/filters/rewrites entire JSONL files; acceptable at current scale but requires optimization if files grow very large
- **No cross-agent learning** -- per-agent scoping means agents don't share effectiveness data (design doc scopes this to V2)
- **Aggregate staleness** -- incremental updates approximate; full recompute runs on timer (1h active / 24h passive), so aggregates may lag

### Risks

- **JSONL file growth** -- mitigated by 90-day retention pruning on periodic timer
- **Path traversal** -- mitigated by `validateAgentId()` rejecting `/`, `\`, `..`, null bytes (with test coverage)
- **Concurrent writes** -- JSONL appends are atomic per-line on POSIX; JSON writes use unique temp files + rename

## Design doc alignment

| Design Doc Requirement           | Status   | Notes                                                                                            |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| A. Canonical state compatibility | Partial  | `PolicyContext` is thinner than envisioned `CanonicalUserState`; `extensions` field added for V2 |
| B. Candidate action ranking      | Complete | 5-factor composite heuristic with configurable weights                                           |
| C. Action ledger                 | Complete | JSONL append-only with per-agent scoping                                                         |
| D. Outcome logging               | Complete | Immediate (delivery) + delayed (user_replied) with latency-based value                           |
| E. Aggregate policy memory       | Complete | Per-type, hour, channel, fatigue correlation                                                     |
| F. Constraint layer              | Complete | 4 built-in + custom rules via config                                                             |
| G. Advisory-first rollout        | Complete | off/passive/advisory/active modes with feature flags                                             |
| Log retention                    | Complete | `pruneOldRecords()` + periodic maintenance timer                                                 |
| Periodic recompute               | Complete | Maintenance timer in `init.ts`                                                                   |
| Testing                          | Complete | 199 tests including scoring, constraints, integration, observability, path traversal             |
| Observability                    | Complete | `getDebugInfo()`, `explainScore()`, `getRecentHistory()`, structured logging                     |

## Future work (Phases 4-5)

- **Richer context signals** -- populate `PolicyContext.extensions` with calendar, wearable, task, and preference data
- **Horizon-based outcome evaluation** -- use `outcomeHorizons` config for multi-timescale outcome tracking
- **Cross-agent learning** -- shared aggregate stats across agents for global policy priors
- **Sequence-aware scoring** -- capture action-outcome sequences for temporal pattern detection
- **Contextual bandits** -- optional Thompson sampling or UCB exploration for action selection
- **Config-driven retention** -- read `logRetentionDays` from persisted config instead of hardcoded default
- **Streaming prune** -- line-by-line prune for large JSONL files to avoid full-file load
