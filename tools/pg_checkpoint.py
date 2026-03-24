#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import List

TOOLS_DIR = Path(__file__).resolve().parent
PG_MEMORY = Path(os.getenv("OPENCLAW_PG_MEMORY_PATH", str(TOOLS_DIR / "pg_memory.py")))
NAMESPACE_POLICY = TOOLS_DIR / "namespace_integrity.py"


def run_store(namespace: str, content: str, tags: List[str]) -> dict:
    cmd = [
        "python3",
        str(PG_MEMORY),
        "store",
        namespace,
        content,
        json.dumps(tags, ensure_ascii=False),
    ]
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out)


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


def main() -> int:
    p = argparse.ArgumentParser(description="Store a structured checkpoint into Postgres memory.")
    p.add_argument("--namespace", help="Target project namespace, e.g. project:openclaw-improvement")
    p.add_argument("--force-cross-project", action="store_true", help="Allow explicit cross-project write when authorized")
    p.add_argument("--reason", default="", help="Reason for forced cross-project write")
    p.add_argument("--completed", required=True, help="What was completed")
    p.add_argument("--decisions", default="", help="Decisions made")
    p.add_argument("--blockers", default="", help="Current blockers")
    p.add_argument("--next", dest="next_step", default="", help="Next concrete step")
    p.add_argument("--artifacts", default="", help="Comma-separated key artifacts/paths")
    p.add_argument("--extra-tags", default="", help="Comma-separated extra tags")
    args = p.parse_args()

    resolution = resolve_namespace(
        args.namespace,
        force=args.force_cross_project,
        reason=args.reason,
        operation="pg_checkpoint",
    )
    namespace = resolution["namespace"]

    ts = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    art = [a.strip() for a in args.artifacts.split(",") if a.strip()]

    lines = [
        f"checkpoint ts={ts}",
        f"namespace={namespace}",
        f"completed: {args.completed}",
    ]
    if args.decisions:
        lines.append(f"decisions: {args.decisions}")
    if args.blockers:
        lines.append(f"blockers: {args.blockers}")
    if args.next_step:
        lines.append(f"next: {args.next_step}")
    if art:
        lines.append("artifacts: " + "; ".join(art))

    content = "\n".join(lines)

    base_tags = ["checkpoint", "durable", "handoff", namespace.replace(":", "-")]
    extra = [t.strip() for t in args.extra_tags.split(",") if t.strip()]
    tags = base_tags + extra

    project_store = run_store(namespace, content, tags)

    mirror = (
        f"checkpoint ts={ts} namespace={namespace} "
        f"completed={args.completed} next={args.next_step or 'n/a'}"
    )
    mirror_tags = ["checkpoint", "index", namespace.replace(":", "-")]
    index_store = run_store("ops:checkpoints", mirror, mirror_tags)

    print(
        json.dumps(
            {
                "ok": True,
                "namespace": namespace,
                "activeNamespace": resolution.get("activeNamespace"),
                "forced": bool(resolution.get("forced")),
                "projectEntryId": project_store.get("id"),
                "indexEntryId": index_store.get("id"),
                "timestamp": ts,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
