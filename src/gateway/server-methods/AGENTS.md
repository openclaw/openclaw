# Gateway Server Methods Notes

- agent session transcripts are a `parentId` chain/DAG; never append raw `type: "message"` entries via JSONL writes (missing `parentId` can sever the leaf path and break compaction/history). Always await transcript writes via `manager.appendMessageAsync(...)` (or an awaited wrapper that uses it).
