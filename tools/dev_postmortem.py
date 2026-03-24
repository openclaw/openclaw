#!/usr/bin/env python3
"""Store a structured software-dev failure postmortem in Postgres memory."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
PG_MEMORY = Path(os.getenv("OPENCLAW_PG_MEMORY_PATH", str(TOOLS_DIR / "pg_memory.py")))
NAMESPACE_POLICY = TOOLS_DIR / "namespace_integrity.py"


def run_pg_store(namespace: str, content: str, tags: list[str]) -> dict:
    cmd = [
        "python3",
        str(PG_MEMORY),
        "store",
        namespace,
        content,
        json.dumps(tags, ensure_ascii=False),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def resolve_namespace(explicit_namespace: str | None, force: bool, reason: str, operation: str) -> dict:
    cmd = ["python3", str(NAMESPACE_POLICY), "resolve-write", "--operation", operation]
    if explicit_namespace:
        cmd.extend(["--namespace", explicit_namespace])
    if force:
        cmd.append("--force-cross-project")
    if reason:
        cmd.extend(["--reason", reason])

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        raise SystemExit(proc.returncode)
    return json.loads(proc.stdout)


def csv_to_list(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def build_content(args: argparse.Namespace) -> str:
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    lines: list[str] = [
        "dev_failure_postmortem v=1",
        f"task_id={args.task_id}",
        f"phase={args.phase}",
        f"timestamp_utc={now}",
        f"failure_summary={args.summary.strip()}",
        f"root_cause={args.root_cause.strip() if args.root_cause else 'unspecified'}",
    ]

    if args.impact:
        lines.append(f"impact={args.impact.strip()}")
    if args.detection:
        lines.append(f"detection={args.detection.strip()}")
    if args.fix:
        lines.append(f"fix={args.fix.strip()}")
    if args.prevention:
        lines.append(f"prevention_actions={args.prevention.strip()}")

    artifacts = csv_to_list(args.artifacts)
    if artifacts:
        lines.append(f"artifacts={'; '.join(artifacts)}")

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Store structured dev postmortem in Postgres")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--phase", default="implementation")
    parser.add_argument("--summary", required=True)
    parser.add_argument("--root-cause")
    parser.add_argument("--impact")
    parser.add_argument("--detection")
    parser.add_argument("--fix")
    parser.add_argument("--prevention")
    parser.add_argument("--artifacts", help="comma-separated file/artifact paths")
    parser.add_argument("--namespace")
    parser.add_argument("--force-cross-project", action="store_true")
    parser.add_argument("--reason", default="")
    parser.add_argument("--mirror-namespace", default="capability:dev-failure-lessons")
    parser.add_argument("--no-mirror", action="store_true")
    args = parser.parse_args()

    resolution = resolve_namespace(
        args.namespace,
        force=args.force_cross_project,
        reason=args.reason,
        operation="dev_postmortem",
    )
    namespace = resolution["namespace"]

    content = build_content(args)
    tags = [
        "dev-failure-postmortem",
        f"task:{args.task_id}",
        f"phase:{args.phase}",
    ]

    primary = run_pg_store(namespace, content, tags)
    result: dict[str, object] = {
        "ok": True,
        "namespace": namespace,
        "activeNamespace": resolution.get("activeNamespace"),
        "forced": bool(resolution.get("forced")),
        "id": primary.get("id"),
    }

    if not args.no_mirror:
        mirror = run_pg_store(args.mirror_namespace, content, tags)
        result["mirrorNamespace"] = args.mirror_namespace
        result["mirrorId"] = mirror.get("id")

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
