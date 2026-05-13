# Gateway Server Methods Notes

- Pi session transcripts are a `parentId` chain/DAG in SQLite; never append raw `type: "message"` event rows directly (missing `parentId` can sever the leaf path and break compaction/history). Always write transcript messages through the SQLite transcript writer path that maintains parent links.
