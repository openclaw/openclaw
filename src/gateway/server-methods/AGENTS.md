# Gateway Server Methods Notes

- Agent session transcripts = `parentId` chain/DAG. Never append raw `type: "message"` entries via JSONL writes: missing `parentId` can sever leaf path + break compaction/history. Always await transcript writes via `manager.appendMessageAsync(...)` (or awaited wrapper using it).
