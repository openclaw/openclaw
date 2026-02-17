# Gateway Server Methods Notes

- Pi session transcripts are a `parentId` chain/DAG; never append Pi `type: "message"` entries via raw JSONL writes (missing `parentId` can sever the leaf path and break compaction/history). Always write transcript messages via `SessionManager.appendMessage(...)` (or a wrapper that uses it).

## 探索与执行分离

- 主任务应由子代理负责发现与探索（例如文件定位、搜索扫描和上下文收集）。
- 主代理不应执行探索式文件读取；应在拿到子代理汇总后继续执行修改与实现。
