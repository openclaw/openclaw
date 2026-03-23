# Policy Feedback Engine: V1 Specification

## Core Interfaces

### PolicyFeedbackEngine

The top-level entry point for the subsystem. All external callers interact through this interface.

```typescript
interface PolicyFeedbackEngine {
  /** Log a meaningful action taken by the system. Returns a unique action ID. */
  logAction(input: LogActionInput): Promise<{ actionId: string }>;

  /** Log a delayed or immediate outcome associated with a prior action. */
  logOutcome(input: LogOutcomeInput): Promise<void>;

  /**
   * Rank candidate actions given current context and policy state.
   * Returns scored candidates ordered by descending score.
   * In passive mode, returns all candidates with score=1 and no suppression.
   */
  rankCandidates(input: RankCandidatesInput): Promise<ScoredCandidate[]>;

  /**
   * Get policy hints for the current context.
   * Used by prompt injection (advisory mode) and orchestrator decisions.
   */
  getPolicyHints(input: GetPolicyHintsInput): Promise<PolicyHints>;

  /** Trigger aggregate recomputation from logs. Idempotent. */
  recomputeAggregates(agentId?: string): Promise<void>;

  /** Get current engine status for observability. */
  getStatus(): PolicyFeedbackStatus;
}
```

### LogActionInput

```typescript
type LogActionInput = {
  /** Agent that took the action */
  agentId: string;
  /** Session key for the interaction */
  sessionKey: string;
  /** Unique session UUID (regenerated on /new and /reset) */
  sessionId?: string;
  /** Action classification */
  actionType: ActionType;
  /** Channel the action occurred on */
  channelId: string;
  /** Provider account ID for multi-account setups */
  accountId?: string;
  /** Summary of the context at action time (not the full transcript) */
  contextSummary?: string;
  /** The specific tool or skill involved, if applicable */
  toolName?: string;
  /** Optional rationale for the action */
  rationale?: string;
  /** Additional unstructured metadata */
  metadata?: Record<string, unknown>;
};

type ActionType =
  | "agent_reply" // Agent responded to a user message
  | "tool_call" // Agent invoked a specific tool
  | "cron_run" // Scheduled agent run
  | "heartbeat_run" // Heartbeat-triggered agent run
  | "no_op" // System decided not to act
  | "suppressed"; // System suppressed an action due to policy
```

### LogOutcomeInput

```typescript
type LogOutcomeInput = {
  /** The action this outcome relates to */
  actionId: string;
  /** Agent ID (for scoping) */
  agentId: string;
  /** Outcome classification */
  outcomeType: OutcomeType;
  /** Numeric value for the outcome (0-1 normalized where applicable) */
  value?: number;
  /** Time horizon at which this outcome was observed */
  horizonMs?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
};

type OutcomeType =
  | "delivery_success" // Message was delivered successfully
  | "delivery_failure" // Message delivery failed
  | "user_replied" // User sent a follow-up message
  | "user_silent" // No user reply within observation horizon
  | "session_continued" // Session remained active
  | "session_ended" // Session was ended/reset after the action
  | "explicit_positive" // Explicit positive feedback (future)
  | "explicit_negative"; // Explicit negative feedback (future)
```

### RankCandidatesInput and ScoredCandidate

```typescript
type RankCandidatesInput = {
  /** Agent making the decision */
  agentId: string;
  /** Session context */
  sessionKey: string;
  /** Candidate actions to rank */
  candidates: CandidateAction[];
  /** Current context signals */
  context: PolicyContext;
};

type CandidateAction = {
  /** Unique identifier for this candidate */
  id: string;
  /** Action type classification */
  actionType: ActionType;
  /** Tool or skill name, if applicable */
  toolName?: string;
  /** Description of what this action would do */
  description?: string;
  /** Additional metadata for scoring */
  metadata?: Record<string, unknown>;
};

type PolicyContext = {
  /** Channel the interaction is on */
  channelId: string;
  /** Current hour of day (0-23) in the user's timezone */
  hourOfDay?: number;
  /** Number of recent agent actions in the current session */
  recentActionCount?: number;
  /** Time since last agent action in this session (ms) */
  timeSinceLastActionMs?: number;
  /** Number of consecutive agent messages without user reply */
  consecutiveIgnores?: number;
};

type ScoredCandidate = {
  /** The candidate that was scored */
  candidate: CandidateAction;
  /** Computed score (0-1, higher is better) */
  score: number;
  /** Human-readable reasons for the score */
  reasons: string[];
  /** Whether this candidate should be suppressed */
  suppress: boolean;
  /** Which constraint triggered suppression, if any */
  suppressionRule?: string;
};
```

### PolicyHints

```typescript
type GetPolicyHintsInput = {
  agentId: string;
  sessionKey: string;
  channelId: string;
  context?: PolicyContext;
};

type PolicyHints = {
  /** Overall recommendation: proceed normally, proceed with caution, or suppress */
  recommendation: "proceed" | "caution" | "suppress";
  /** Reasons for the recommendation */
  reasons: string[];
  /** Suggested tone adjustments (advisory only, not enforced) */
  toneHints?: string[];
  /** Time-based suggestion (e.g., "user is typically less responsive at this hour") */
  timingHint?: string;
  /** Current intervention fatigue level (0-1, higher = more fatigued) */
  fatigueLevel: number;
  /** Active constraint violations, if any */
  activeConstraints: string[];
  /** Mode the engine is operating in */
  mode: PolicyMode;
};
```

### PolicyFeedbackStatus

```typescript
type PolicyFeedbackStatus = {
  mode: PolicyMode;
  actionLogSize: number;
  outcomeLogSize: number;
  aggregatesComputedAt?: string; // ISO timestamp
  aggregatesStale: boolean;
  constraintRulesLoaded: number;
  lastError?: string;
};

type PolicyMode = "off" | "passive" | "advisory" | "active";
```

---

## Data Model

### ActionRecord (persisted to JSONL)

Each line in `actions.jsonl` is a JSON-serialized ActionRecord.

```typescript
type ActionRecord = {
  /** Unique action ID (ULID or UUID v7 for time-ordering) */
  id: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent that took the action */
  agentId: string;
  /** Session key */
  sessionKey: string;
  /** Session UUID */
  sessionId?: string;
  /** Action classification */
  actionType: ActionType;
  /** Channel */
  channelId: string;
  /** Account ID */
  accountId?: string;
  /** Context summary at action time */
  contextSummary?: string;
  /** Tool or skill name */
  toolName?: string;
  /** Rationale */
  rationale?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Policy mode at the time of the action */
  policyMode: PolicyMode;
  /** If the action was scored, the score and reasons */
  scoring?: {
    score: number;
    reasons: string[];
    suppress: boolean;
    suppressionRule?: string;
  };
};
```

### OutcomeRecord (persisted to JSONL)

Each line in `outcomes.jsonl` is a JSON-serialized OutcomeRecord.

```typescript
type OutcomeRecord = {
  /** Unique outcome ID */
  id: string;
  /** ISO 8601 timestamp when the outcome was observed */
  timestamp: string;
  /** The action this outcome correlates with */
  actionId: string;
  /** Agent ID (for scoping) */
  agentId: string;
  /** Outcome type */
  outcomeType: OutcomeType;
  /** Numeric value (0-1 normalized) */
  value?: number;
  /** Observation horizon in ms (how long after the action) */
  horizonMs?: number;
  /** Metadata */
  metadata?: Record<string, unknown>;
};
```

### AggregateStats (persisted as JSON)

Materialized periodically from the action and outcome logs.

```typescript
type AggregateStats = {
  /** When these aggregates were last computed */
  computedAt: string;
  /** Total actions logged */
  totalActions: number;
  /** Total outcomes logged */
  totalOutcomes: number;
  /** Per-action-type effectiveness */
  byActionType: Record<ActionType, ActionTypeStats>;
  /** Per-hour-of-day effectiveness (0-23 keys) */
  byHourOfDay: Record<number, HourStats>;
  /** Fatigue curve: effectiveness by consecutive-ignore count */
  byConsecutiveIgnores: Record<number, { count: number; replyRate: number }>;
  /** Per-channel effectiveness */
  byChannel: Record<string, { count: number; replyRate: number; avgLatencyMs?: number }>;
};

type ActionTypeStats = {
  count: number;
  outcomeCount: number;
  replyRate: number; // fraction of actions that got a user reply
  avgResponseLatencyMs?: number;
  suppressionRate: number; // fraction of times this action type was suppressed
};

type HourStats = {
  count: number;
  replyRate: number;
  avgResponseLatencyMs?: number;
};
```

### PolicyConfig (persisted as JSON)

```typescript
type PolicyFeedbackConfig = {
  /** Operating mode */
  mode: PolicyMode;
  /** How often to recompute aggregates (ms). Default: 3600000 (1 hour) */
  aggregateIntervalMs: number;
  /** Outcome observation horizons in ms. Default: [60000, 1800000, 86400000] (1min, 30min, 24h) */
  outcomeHorizons: number[];
  /** Constraint rules */
  constraints: ConstraintRule[];
  /** Per-agent overrides (keyed by agentId) */
  agentOverrides?: Record<string, Partial<PolicyFeedbackConfig>>;
  /** Log retention: max age in days. Default: 90 */
  logRetentionDays: number;
  /** Whether to scope logs per-agent or globally. Default: true */
  perAgentScoping: boolean;
};
```

---

## Persistence Design

### Storage Layout

```
~/.openclaw/policy-feedback/
  actions.jsonl              # Global action log (if perAgentScoping=false)
  outcomes.jsonl             # Global outcome log
  aggregates.json            # Global aggregate stats
  policy-config.json         # Runtime config overrides (optional)
  agents/
    <agentId>/
      actions.jsonl          # Per-agent action log (if perAgentScoping=true)
      outcomes.jsonl         # Per-agent outcome log
      aggregates.json        # Per-agent aggregate stats
```

### Write Pattern

All JSONL writes use the append pattern established by the command-logger hook:

```typescript
// Pseudocode -- not implementation
const logLine = JSON.stringify(record) + "\n";
await fs.appendFile(logFilePath, logLine, "utf-8");
```

Directory creation uses `fs.mkdir(dir, { recursive: true })` on first write.

### Read Pattern

Aggregates are read from JSON files (fast, single read). JSONL logs are read line-by-line only during aggregate recomputation (periodic, not on the hot path).

### Rotation / Retention

V1 uses a simple age-based retention: a periodic job (cron) reads the JSONL file, filters out records older than `logRetentionDays`, and rewrites the file. This is infrequent (daily or weekly) and uses a temp-file + rename pattern for atomicity.

---

## Feature Flags and Mode Support

### Configuration in openclaw.json

```json
{
  "policyFeedback": {
    "mode": "passive",
    "aggregateIntervalMs": 3600000,
    "outcomeHorizons": [60000, 1800000, 86400000],
    "constraints": [],
    "logRetentionDays": 90,
    "perAgentScoping": true
  }
}
```

### Environment Variable Override

`OPENCLAW_POLICY_FEEDBACK_MODE=off|passive|advisory|active`

Environment variable takes precedence over config file, enabling quick disablement without config changes.

### Mode Behavior Matrix

| Mode     | Action Logging | Outcome Logging | Aggregates | Prompt Hints | Gate/Suppress | Tool Suppress |
| -------- | -------------- | --------------- | ---------- | ------------ | ------------- | ------------- |
| off      | No             | No              | No         | No           | No            | No            |
| passive  | Yes            | Yes             | Yes        | No           | No            | No            |
| advisory | Yes            | Yes             | Yes        | Yes (soft)   | No            | No            |
| active   | Yes            | Yes             | Yes        | Yes          | Yes           | Yes           |

### Passive Mode Safety Guarantees

In passive mode:

- No code paths in dispatch, agent, or delivery are modified
- All hook handlers are registered but only append to logs
- aggregate computation runs but results are not consumed by any decision path
- The subsystem is fully removable by setting mode to "off"
- Performance impact: one async file append per message event (non-blocking via fire-and-forget)

---

## Testing Strategy

### Unit Tests (colocated `*.test.ts`)

| File                  | Tests                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger.test.ts`      | Action logging: valid input writes correct JSONL line, invalid input is rejected, concurrent writes do not corrupt                                       |
| `outcomes.test.ts`    | Outcome logging: correlates with action ID, handles missing action gracefully, respects horizon config                                                   |
| `ranker.test.ts`      | Score computation: deterministic given same aggregates and context, suppression rules applied correctly, all candidates scored, no-op candidate included |
| `constraints.test.ts` | Each constraint type: max_actions_per_period, consecutive_ignores, time_of_day_block, min_interval, low_effectiveness                                    |
| `aggregates.test.ts`  | Aggregate computation: correct counts from fixture JSONL, handles empty logs, handles malformed lines gracefully                                         |
| `persistence.test.ts` | JSONL append/read round-trip, directory creation, atomic aggregate write                                                                                 |
| `engine.test.ts`      | Integration: full cycle from logAction -> logOutcome -> recomputeAggregates -> rankCandidates                                                            |
| `config.test.ts`      | Config loading, defaults, env var override, per-agent override merge                                                                                     |

### Replay Harness

A fixture-driven test helper that:

1. Loads a predefined sequence of action and outcome records from a fixture file
2. Runs aggregate computation
3. Runs ranking for a set of test scenarios
4. Asserts expected scores and suppression decisions

This enables regression testing of the scoring logic as it evolves.

### Observability

- All policy decisions logged via `createSubsystemLogger("policy-feedback")`
- Debug-level logs for every action logged, outcome logged, and ranking computed
- Info-level logs for constraint violations and suppressions
- Warn-level logs for persistence errors (fail-open)
- `getStatus()` method exposes current state for the gateway health endpoint

---

## V1 Scope Summary

**In scope:**

- JSONL-based action and outcome logging
- Internal hook handlers for message:received, message:sent
- Plugin hook handlers for agent_end, after_tool_call
- Outcome correlation (response latency, user replied/silent)
- Periodic aggregate computation
- Basic constraint evaluation (max actions/period, consecutive ignores)
- Basic candidate ranking with heuristic scoring
- Advisory prompt hint generation
- Feature flag / mode support
- Observability via subsystem logger
- Replay test harness

**Out of scope for V1:**

- Active gate in dispatch path (Phase 3)
- Tool-level suppression via before_tool_call (Phase 3)
- Embedding-based context similarity
- Sequence modeling
- Contextual bandits / exploration
- Cross-agent learning
- Web UI dashboard
- External signal integration
