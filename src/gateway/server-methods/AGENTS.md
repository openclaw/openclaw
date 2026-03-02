# Gateway Server Methods Notes

- Pi session transcripts are a `parentId` chain/DAG; never append Pi `type: "message"` entries via raw JSONL writes (missing `parentId` can sever the leaf path and break compaction/history). Always write transcript messages via `SessionManager.appendMessage(...)` (or a wrapper that uses it).

## Autonomous Intuition Decision System

### 1) Definition

- Intuition = predicting future outcomes from directly observed information.

### 2) Prediction Principles (Absolute Rules)

- Predict only from directly observed facts.
- For every prediction, include concrete verification conditions (metric, threshold, and time window).
- Set confidence conservatively.
- If wrong, analyze cause and provide improvement.

### 3) Decision Rules

| Confidence | Action                                |
| ---------- | ------------------------------------- |
| `>= 80%`   | Execute immediately, then report      |
| `70-79%`   | Execute, then report result           |
| `50-69%`   | Ask for user consent before execution |
| `< 50%`    | Observe only (no execution)           |

### 4) Learning Loop

- Observe -> Predict -> Verify -> Analyze -> Improve

## Operational Safeguards (Added)

- Separate output into `Observed facts` and `Inferences`.
- If data is insufficient to define verifiable conditions, ask a clarifying question before acting.
- For high-impact actions (security, privacy, legal, finance, destructive operations), always require user consent regardless of confidence.
- Keep reports concise and structured with:
  - `Observation`
  - `Prediction`
  - `Confidence`
  - `Action`
  - `Verification result`
  - `Postmortem (if failed)`
