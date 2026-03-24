#!/usr/bin/env python3
"""Namespace sanitization utility with dry-run default.

Confidence policy:
- >=0.90: auto-move candidate
- 0.70-0.89: manual-review
- <0.70: no-move
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent
PG_MEMORY = Path(os.getenv("OPENCLAW_PG_MEMORY_PATH", str(TOOLS_DIR / "pg_memory.py")))
NAMESPACE_POLICY = TOOLS_DIR / "namespace_integrity.py"
MANIFEST_DIR = Path("/home/node/.openclaw/workspace/.runtime/namespace-integrity/sanitize")
PROJECT_NS_RE = re.compile(r"project:[a-z0-9][a-z0-9-]{1,63}")


def run_pg(args: list[str]) -> dict[str, Any]:
    cmd = ["python3", str(PG_MEMORY), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "pg_memory failure")
    data = json.loads(proc.stdout or "{}")
    return data if isinstance(data, dict) else {"data": data}


def run_audit(event: str, code: str, payload: dict[str, Any]) -> None:
    cmd = [
        "python3",
        str(NAMESPACE_POLICY),
        "audit-event",
        "--event",
        event,
        "--code",
        code,
        "--details-json",
        json.dumps(payload, ensure_ascii=False),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def detect_confidence(content: str, target_namespace: str) -> float:
    text = content or ""
    target_hits = text.count(target_namespace)
    project_mentions = PROJECT_NS_RE.findall(text)

    if target_hits >= 2:
        return 0.95
    if target_hits == 1:
        return 0.85
    if target_namespace in project_mentions:
        return 0.8
    if project_mentions:
        return 0.6
    return 0.4


def classify(confidence: float) -> str:
    if confidence >= 0.90:
        return "auto-move"
    if confidence >= 0.70:
        return "manual-review"
    return "no-move"


def build_batch_id() -> str:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"sanitize-{ts}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Sanitize namespace contamination with dry-run default")
    parser.add_argument("--source-namespace", required=True)
    parser.add_argument("--target-namespace", required=True)
    parser.add_argument("--query", default="", help="optional search query for candidate retrieval")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--batch-id", default="")
    parser.add_argument("--apply", action="store_true", help="execute auto-move candidates")
    parser.add_argument("--reason", default="")
    args = parser.parse_args()

    batch_id = args.batch_id or build_batch_id()
    query = args.query.strip() or args.target_namespace
    dry_run = not args.apply

    search = run_pg(["search", args.source_namespace, query, str(args.limit)])
    results = search.get("results", []) if isinstance(search, dict) else []
    if not isinstance(results, list):
        results = []

    plan: list[dict[str, Any]] = []
    moved: list[dict[str, Any]] = []

    for item in results:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "")
        rec_id = item.get("id")
        confidence = detect_confidence(content, args.target_namespace)
        action = classify(confidence)

        entry: dict[str, Any] = {
            "id": rec_id,
            "confidence": round(confidence, 3),
            "action": action,
            "sourceNamespace": args.source_namespace,
            "targetNamespace": args.target_namespace,
            "preview": content.replace("\n", " ")[:220],
        }
        plan.append(entry)

        if dry_run or action != "auto-move":
            continue

        if not args.reason.strip():
            raise SystemExit("ERROR_CODE=SANITIZE_REASON_REQUIRED --reason is required when --apply is set")

        copied_content = "\n".join(
            [
                "namespace_sanitize_copy v=1",
                f"batch_id={batch_id}",
                f"migrated_from_id={rec_id}",
                f"migrated_from_namespace={args.source_namespace}",
                "",
                content,
            ]
        )
        copy_res = run_pg(
            [
                "store",
                args.target_namespace,
                copied_content,
                json.dumps(["sanitize-copy", f"batch:{batch_id}", f"from:{args.source_namespace}"], ensure_ascii=False),
            ]
        )

        tombstone = {
            "v": 1,
            "type": "sanitize_tombstone",
            "batchId": batch_id,
            "sourceId": rec_id,
            "movedToNamespace": args.target_namespace,
            "movedRecordId": copy_res.get("id"),
            "reason": args.reason.strip(),
            "movedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        }
        tombstone_res = run_pg(
            [
                "store",
                args.source_namespace,
                json.dumps(tombstone, ensure_ascii=False),
                json.dumps(["sanitize-tombstone", f"batch:{batch_id}", f"target:{args.target_namespace}"], ensure_ascii=False),
            ]
        )

        moved.append(
            {
                "sourceId": rec_id,
                "copiedId": copy_res.get("id"),
                "tombstoneId": tombstone_res.get("id"),
                "confidence": round(confidence, 3),
            }
        )

    summary = {
        "ok": True,
        "batchId": batch_id,
        "dryRun": dry_run,
        "sourceNamespace": args.source_namespace,
        "targetNamespace": args.target_namespace,
        "query": query,
        "counts": {
            "total": len(plan),
            "autoMove": sum(1 for x in plan if x["action"] == "auto-move"),
            "manualReview": sum(1 for x in plan if x["action"] == "manual-review"),
            "noMove": sum(1 for x in plan if x["action"] == "no-move"),
            "moved": len(moved),
        },
        "plan": plan,
        "moved": moved,
    }

    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = MANIFEST_DIR / f"{batch_id}.json"
    manifest_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary["manifestPath"] = str(manifest_path)

    event = "namespace_sanitize_dry_run" if dry_run else "namespace_sanitize_applied"
    code = "NAMESPACE_SANITIZE_DRY_RUN" if dry_run else "NAMESPACE_SANITIZE_APPLIED"
    run_audit(event, code, {"batchId": batch_id, "source": args.source_namespace, "target": args.target_namespace, "moved": len(moved)})

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
