# Gateway Server Methods Notes（轉為繁體中文）
（轉為繁體中文）
- Pi session transcripts are a `parentId` chain/DAG; never append Pi `type: "message"` entries via raw JSONL writes (missing `parentId` can sever the leaf path and break compaction/history). Always write transcript messages via `SessionManager.appendMessage(...)` (or a wrapper that uses it).（轉為繁體中文）
