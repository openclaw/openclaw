#!/usr/bin/env python3
"""Retrieve concise failure lessons from Postgres before implementation work."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
PG_MEMORY = Path(os.getenv("OPENCLAW_PG_MEMORY_PATH", str(TOOLS_DIR / "pg_memory.py")))
NAMESPACE_POLICY = TOOLS_DIR / "namespace_integrity.py"


def parse_kv(content: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def run_search(namespace: str, query: str, limit: int) -> list[dict]:
    cmd = ["python3", str(PG_MEMORY), "search", namespace, query, str(limit)]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    payload = json.loads(out.stdout)
    return payload.get("results", []) if isinstance(payload, dict) else []


def resolve_read_namespace(explicit_namespace: str | None) -> str:
    if explicit_namespace:
        return explicit_namespace

    cmd = ["python3", str(NAMESPACE_POLICY), "get-active"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        raise SystemExit(proc.returncode)
    payload = json.loads(proc.stdout)
    return str(payload["namespace"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Load relevant dev failure lessons from Postgres")
    parser.add_argument("--query", required=True)
    parser.add_argument("--task-id")
    parser.add_argument("--namespace")
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()

    namespace = resolve_read_namespace(args.namespace)

    search_query = f"dev_failure_postmortem {args.query}".strip()
    results = run_search(namespace, search_query, args.limit)
    if not results:
        # Fallback: retrieve recent postmortems if semantic query is sparse.
        results = run_search(namespace, "dev_failure_postmortem", args.limit)

    if args.task_id:
        task_hits = run_search(namespace, f"dev_failure_postmortem task_id={args.task_id}", args.limit)
        by_id = {str(item.get("id")): item for item in results}
        for item in task_hits:
            by_id[str(item.get("id"))] = item
        results = list(by_id.values())

    lessons: list[dict[str, str]] = []
    for item in results:
        content = str(item.get("content") or "")
        parsed = parse_kv(content)
        if parsed.get("dev_failure_postmortem v") != "1":
            continue
        lessons.append(
            {
                "id": str(item.get("id")),
                "task": parsed.get("task_id", "unknown"),
                "phase": parsed.get("phase", "unknown"),
                "summary": parsed.get("failure_summary", ""),
                "rootCause": parsed.get("root_cause", ""),
                "prevention": parsed.get("prevention_actions", ""),
            }
        )

    print(json.dumps({"count": len(lessons), "namespace": namespace, "lessons": lessons}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
