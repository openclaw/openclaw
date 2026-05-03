#!/usr/bin/env python3
"""Stale Topic Resolver for Paperclip attention broker.

Finds issues stuck in 'needs_attention' blocker attention state for >24 hours
and reports on them. Pure deterministic Python — no LLM judgment needed.

Usage:
    python3 stale_resolver.py [--json]

Environment variables:
    PAPERCLIP_API_KEY: Paperclip API key for authentication
    PAPERCLIP_COMPANY_ID: Company ID (defaults to Kaleidoscope AGE company)
    PAPERCLIP_API_BASE: API base URL (defaults to http://127.0.0.1:3101)
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

API_BASE = os.getenv("PAPERCLIP_API_BASE", "http://127.0.0.1:3101")
COMPANY_ID = os.getenv("PAPERCLIP_COMPANY_ID", "0f6e2b9b-12b2-4306-9798-16325c788e6f")
API_KEY = os.getenv("PAPERCLIP_API_KEY", "")
STALE_THRESHOLD_HOURS = 24


def fetch_issues():
    """Fetch all open issues from Paperclip API."""
    if not API_KEY:
        raise ValueError("PAPERCLIP_API_KEY environment variable not set")
    
    states = ["backlog", "todo", "in_progress", "in_review", "blocked"]
    all_issues = []
    for state in states:
        url = f"{API_BASE}/api/companies/{COMPANY_ID}/issues?status={state}"
        req = urllib.request.Request(url)
        req.add_header("x-paperclip-api-key", API_KEY)
        try:
            resp = urllib.request.urlopen(req, timeout=30)
            issues = json.loads(resp.read())
            all_issues.extend(issues)
        except Exception as e:
            print(f"Warning: Failed to fetch {state} issues: {e}", file=sys.stderr)
    return all_issues


def find_stale_topics(issues, cutoff_dt):
    """Find issues with needs_attention state older than cutoff."""
    stale = []
    needs_attention_count = 0
    for issue in issues:
        att = issue.get("blockerAttention") or {}
        if att.get("state") != "needs_attention":
            continue
        needs_attention_count += 1
        updated_str = issue.get("updatedAt", "")
        if not updated_str:
            continue
        try:
            updated_dt = datetime.fromisoformat(updated_str.replace("Z", "+00:00"))
            if updated_dt < cutoff_dt:
                stale.append({
                    "identifier": issue["identifier"],
                    "title": issue.get("title", ""),
                    "updatedAt": updated_str,
                    "blocker": att.get("sampleBlockerIdentifier"),
                    "attentionBlockerCount": att.get("attentionBlockerCount", 0),
                })
        except (ValueError, TypeError):
            continue
    return stale, needs_attention_count


def main():
    use_json = "--json" in sys.argv
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=STALE_THRESHOLD_HOURS)

    issues = fetch_issues()
    stale, needs_attention_count = find_stale_topics(issues, cutoff)

    result = {
        "checked": len(issues),
        "stale_found": len(stale),
        "resolved": 0,
        "failed": 0,
        "needs_attention_total": needs_attention_count,
        "details": stale[:10],  # Cap details for readability
    }

    if use_json:
        print(json.dumps(result, indent=2))
    else:
        if result["stale_found"] == 0:
            print(
                f"Stale Topic Resolver ran clean. Checked {result['checked']} topics, "
                f"0 stale found, 0 resolved. All {needs_attention_count} "
                f"attention-brokered issues are healthy."
            )
        else:
            print(
                f"Stale Topic Resolver found {result['stale_found']} stale topics "
                f"out of {needs_attention_count} attention-brokered "
                f"(checked {result['checked']} total)."
            )

    sys.exit(0)


if __name__ == "__main__":
    main()
