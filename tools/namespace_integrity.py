#!/usr/bin/env python3
"""Namespace integrity guardrails for Postgres memory tooling.

Provides a shared policy resolver used by local scripts.
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROJECT_NAMESPACE_RE = re.compile(r"^project:[a-z0-9][a-z0-9-]{1,63}$")
ACTIVE_NAMESPACE_KEY = "system:config.active_project_namespace"
ACTIVE_NAMESPACE_STORE = ACTIVE_NAMESPACE_KEY
FORCE_ALLOWLIST_DEFAULT = {"agent:main:main", "owner:+13479278207"}
VALID_REASONS = {"scope-switch", "bootstrap", "manual"}

TOOLS_DIR = Path(__file__).resolve().parent
PG_MEMORY_PATH = Path(os.getenv("OPENCLAW_PG_MEMORY_PATH", str(TOOLS_DIR / "pg_memory.py")))
AUDIT_LOG_PATH = Path(
    os.getenv(
        "OPENCLAW_NAMESPACE_AUDIT_LOG",
        "/home/node/.openclaw/workspace/.runtime/namespace-integrity/audit.log",
    )
)


class NamespacePolicyError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
            },
        }


@dataclass
class ActiveNamespaceRecord:
    namespace: str
    updated_at: str
    updated_by: str
    reason: str
    v: int = 1

    def to_payload(self) -> dict[str, Any]:
        return {
            "v": self.v,
            "namespace": self.namespace,
            "updatedAt": self.updated_at,
            "updatedBy": self.updated_by,
            "reason": self.reason,
        }


def _run_pg_memory(args: list[str]) -> dict[str, Any]:
    cmd = ["python3", str(PG_MEMORY_PATH), *args]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise NamespacePolicyError(
            "PG_MEMORY_ERROR",
            "pg_memory command failed",
            details={"command": " ".join(cmd), "stderr": out.stderr.strip(), "stdout": out.stdout.strip()},
        )
    try:
        payload = json.loads(out.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise NamespacePolicyError(
            "PG_MEMORY_PARSE_ERROR",
            "pg_memory output was not valid JSON",
            details={"stdout": out.stdout.strip(), "error": str(exc)},
        ) from exc
    return payload if isinstance(payload, dict) else {"data": payload}


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def resolve_actor(explicit_actor: str | None = None) -> str:
    if explicit_actor:
        return explicit_actor.strip()

    actor = os.getenv("OPENCLAW_ACTOR_ID", "").strip()
    if actor:
        return actor

    session_key = os.getenv("OPENCLAW_SESSION_KEY", "").strip() or os.getenv("SESSION_KEY", "").strip()
    if session_key:
        return f"session:{session_key}"

    return f"user:{getpass.getuser()}"


def force_allowlist() -> set[str]:
    raw = os.getenv("OPENCLAW_FORCE_ALLOWLIST", "")
    if not raw.strip():
        return set(FORCE_ALLOWLIST_DEFAULT)
    return {item.strip() for item in raw.split(",") if item.strip()}


def validate_project_namespace(namespace: str) -> None:
    if not PROJECT_NAMESPACE_RE.match(namespace):
        raise NamespacePolicyError(
            "INVALID_NAMESPACE",
            "Namespace must match project namespace regex",
            details={"namespace": namespace, "regex": PROJECT_NAMESPACE_RE.pattern},
        )


def _parse_active_record(item: dict[str, Any]) -> ActiveNamespaceRecord | None:
    content = item.get("content")
    if not isinstance(content, str) or not content.strip():
        return None

    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return None

    if not isinstance(payload, dict):
        return None

    try:
        v = int(payload.get("v"))
        namespace = str(payload["namespace"])
        updated_at = str(payload["updatedAt"])
        updated_by = str(payload["updatedBy"])
        reason = str(payload["reason"])
    except (KeyError, TypeError, ValueError):
        return None

    if v != 1 or reason not in VALID_REASONS:
        return None
    if not PROJECT_NAMESPACE_RE.match(namespace):
        return None

    return ActiveNamespaceRecord(namespace=namespace, updated_at=updated_at, updated_by=updated_by, reason=reason, v=v)


def get_active_namespace_record() -> ActiveNamespaceRecord:
    payload = _run_pg_memory(["search", ACTIVE_NAMESPACE_STORE, "\"namespace\"", "20"])
    results = payload.get("results", [])
    if not isinstance(results, list):
        results = []

    for item in results:
        if not isinstance(item, dict):
            continue
        parsed = _parse_active_record(item)
        if parsed:
            return parsed

    raise NamespacePolicyError(
        "ACTIVE_NAMESPACE_UNSET",
        "Active project namespace is unset; initialize explicitly before writes.",
        details={"key": ACTIVE_NAMESPACE_KEY},
    )


def set_active_namespace(namespace: str, *, reason: str, actor: str | None = None) -> dict[str, Any]:
    validate_project_namespace(namespace)
    if reason not in VALID_REASONS:
        raise NamespacePolicyError(
            "INVALID_ACTIVE_NAMESPACE_REASON",
            "Reason must be one of scope-switch|bootstrap|manual",
            details={"reason": reason},
        )

    resolved_actor = resolve_actor(actor)
    record = ActiveNamespaceRecord(
        namespace=namespace,
        updated_at=_now_iso(),
        updated_by=resolved_actor,
        reason=reason,
        v=1,
    )
    content = json.dumps(record.to_payload(), ensure_ascii=False)
    tags = json.dumps(["config", "active-project-namespace", "namespace-integrity"], ensure_ascii=False)
    store = _run_pg_memory(["store", ACTIVE_NAMESPACE_STORE, content, tags])
    return {
        "ok": True,
        "key": ACTIVE_NAMESPACE_KEY,
        "namespace": namespace,
        "reason": reason,
        "updatedBy": resolved_actor,
        "updatedAt": record.updated_at,
        "storeId": store.get("id"),
    }


def append_audit_event(event: dict[str, Any]) -> None:
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"ts": _now_iso(), **event}
    with AUDIT_LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def resolve_write_namespace(
    explicit_namespace: str | None,
    *,
    force_cross_project: bool = False,
    reason: str = "",
    actor: str | None = None,
    operation: str = "write",
) -> dict[str, Any]:
    active = get_active_namespace_record()
    resolved_actor = resolve_actor(actor)

    if force_cross_project and not reason.strip():
        raise NamespacePolicyError(
            "FORCE_REASON_REQUIRED",
            "Cross-project force requires --reason <non-empty>",
            details={"operation": operation},
        )

    if explicit_namespace:
        validate_project_namespace(explicit_namespace)
        target = explicit_namespace
    else:
        target = active.namespace

    forced = False
    if target != active.namespace:
        if not force_cross_project:
            raise NamespacePolicyError(
                "NAMESPACE_MISMATCH",
                "Requested namespace does not match active namespace; explicit force is required.",
                details={"activeNamespace": active.namespace, "requestedNamespace": target, "operation": operation},
            )

        if not reason.strip():
            raise NamespacePolicyError(
                "FORCE_REASON_REQUIRED",
                "Cross-project force requires --reason <non-empty>",
                details={"activeNamespace": active.namespace, "requestedNamespace": target, "operation": operation},
            )

        if resolved_actor not in force_allowlist():
            raise NamespacePolicyError(
                "FORCE_CROSS_PROJECT_DENIED",
                "Actor is not authorized for cross-project force override.",
                details={"actor": resolved_actor, "operation": operation},
            )

        forced = True
        append_audit_event(
            {
                "event": "cross_project_force_override",
                "code": "CROSS_PROJECT_FORCE_OVERRIDE",
                "operation": operation,
                "actor": resolved_actor,
                "activeNamespace": active.namespace,
                "targetNamespace": target,
                "reason": reason,
            }
        )

    return {
        "ok": True,
        "namespace": target,
        "activeNamespace": active.namespace,
        "forced": forced,
        "actor": resolved_actor,
        "forceReason": reason.strip(),
    }


def _print_json(payload: dict[str, Any], *, err: bool = False) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    if err:
        print(text, file=sys.stderr)
    else:
        print(text)


def _cmd_get_active(_args: argparse.Namespace) -> int:
    record = get_active_namespace_record()
    _print_json({"ok": True, "key": ACTIVE_NAMESPACE_KEY, **record.to_payload()})
    return 0


def _cmd_set_active(args: argparse.Namespace) -> int:
    result = set_active_namespace(args.namespace, reason=args.reason, actor=args.actor)
    append_audit_event(
        {
            "event": "active_namespace_set",
            "code": "ACTIVE_NAMESPACE_SET",
            "actor": result["updatedBy"],
            "namespace": args.namespace,
            "reason": args.reason,
        }
    )
    _print_json(result)
    return 0


def _cmd_resolve_write(args: argparse.Namespace) -> int:
    result = resolve_write_namespace(
        args.namespace,
        force_cross_project=args.force_cross_project,
        reason=args.reason or "",
        actor=args.actor,
        operation=args.operation,
    )
    _print_json(result)
    return 0


def _cmd_audit_event(args: argparse.Namespace) -> int:
    event: dict[str, Any] = {
        "event": args.event,
        "code": args.code or "NAMESPACE_AUDIT_EVENT",
    }
    if args.actor:
        event["actor"] = resolve_actor(args.actor)
    if args.from_namespace:
        event["fromNamespace"] = args.from_namespace
    if args.to_namespace:
        event["toNamespace"] = args.to_namespace
    if args.reason:
        event["reason"] = args.reason
    if args.operation:
        event["operation"] = args.operation
    if args.details_json:
        try:
            details = json.loads(args.details_json)
            if isinstance(details, dict):
                event.update(details)
        except json.JSONDecodeError as exc:
            raise NamespacePolicyError(
                "INVALID_AUDIT_DETAILS_JSON",
                "Failed to parse --details-json payload",
                details={"error": str(exc)},
            ) from exc

    append_audit_event(event)
    _print_json({"ok": True, "event": event["event"], "code": event["code"]})
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Namespace integrity policy helper")
    sub = parser.add_subparsers(dest="command", required=True)

    p_get = sub.add_parser("get-active")
    p_get.set_defaults(func=_cmd_get_active)

    p_set = sub.add_parser("set-active")
    p_set.add_argument("--namespace", required=True)
    p_set.add_argument("--reason", required=True)
    p_set.add_argument("--actor")
    p_set.set_defaults(func=_cmd_set_active)

    p_resolve = sub.add_parser("resolve-write")
    p_resolve.add_argument("--namespace")
    p_resolve.add_argument("--force-cross-project", action="store_true")
    p_resolve.add_argument("--reason", default="")
    p_resolve.add_argument("--actor")
    p_resolve.add_argument("--operation", default="write")
    p_resolve.set_defaults(func=_cmd_resolve_write)

    p_audit = sub.add_parser("audit-event")
    p_audit.add_argument("--event", required=True)
    p_audit.add_argument("--code", default="")
    p_audit.add_argument("--actor")
    p_audit.add_argument("--operation", default="")
    p_audit.add_argument("--from-namespace", default="")
    p_audit.add_argument("--to-namespace", default="")
    p_audit.add_argument("--reason", default="")
    p_audit.add_argument("--details-json", default="")
    p_audit.set_defaults(func=_cmd_audit_event)

    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except NamespacePolicyError as exc:
        _print_json(exc.to_dict(), err=True)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
