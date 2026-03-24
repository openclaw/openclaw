#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

DB_PATH = Path(os.getenv("STUB_PG_DB", "/tmp/stub_pg_memory_db.json"))


def load_db() -> dict:
    if not DB_PATH.exists():
        return {"next_id": 1, "records": []}
    return json.loads(DB_PATH.read_text(encoding="utf-8"))


def save_db(db: dict) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")


def cmd_store(args: list[str]) -> int:
    if len(args) < 2:
        print("usage: store <namespace> <content> [tags_json]", file=sys.stderr)
        return 2
    namespace, content = args[0], args[1]
    tags = json.loads(args[2]) if len(args) > 2 else []

    fail_ns = os.getenv("STUB_FAIL_ON_STORE_NAMESPACE", "")
    if fail_ns and namespace == fail_ns:
        print(json.dumps({"ok": False, "code": "STUB_STORE_FAIL", "namespace": namespace}), file=sys.stderr)
        return 9

    db = load_db()
    rec_id = db["next_id"]
    db["next_id"] += 1
    db["records"].append({"id": rec_id, "namespace": namespace, "content": content, "tags": tags})
    save_db(db)
    print(json.dumps({"ok": True, "id": rec_id}))
    return 0


def cmd_search(args: list[str]) -> int:
    if len(args) < 2:
        print("usage: search <namespace> <query> [limit]", file=sys.stderr)
        return 2
    namespace, query = args[0], args[1]
    limit = int(args[2]) if len(args) > 2 else 5

    db = load_db()
    candidates = [r for r in db["records"] if r.get("namespace") == namespace]

    q = query.strip('"').lower()
    if q:
        candidates = [r for r in candidates if q in str(r.get("content", "")).lower() or any(q in str(t).lower() for t in r.get("tags", []))]

    candidates = list(reversed(candidates))[:limit]
    print(json.dumps({"ok": True, "results": candidates}))
    return 0


def cmd_get(args: list[str]) -> int:
    if not args:
        print("usage: get <id>", file=sys.stderr)
        return 2
    target_id = int(args[0])
    db = load_db()
    for rec in db["records"]:
        if int(rec.get("id", -1)) == target_id:
            print(json.dumps(rec))
            return 0
    print(json.dumps({"ok": False, "code": "NOT_FOUND"}), file=sys.stderr)
    return 4


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: fake_pg_memory.py <search|store|get>", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "store":
        return cmd_store(args)
    if cmd == "search":
        return cmd_search(args)
    if cmd == "get":
        return cmd_get(args)
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
