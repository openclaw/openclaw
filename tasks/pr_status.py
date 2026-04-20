#!/usr/bin/env python3
import subprocess, json

result = subprocess.run(
    ["gh", "api", "repos/openclaw/openclaw/pulls/68976", "--jq", "."],
    capture_output=True, text=True, encoding="utf-8"
)
data = json.loads(result.stdout)

print(f"Title: {data.get('title', 'N/A')}")
print(f"State: {data.get('state', 'N/A')}")
print(f"Mergeable: {data.get('mergeable', 'N/A')}")
print(f"MergeableState: {data.get('mergeable_state', 'N/A')}")
print(f"Additions: {data.get('additions', 0)}")
print(f"Deletions: {data.get('deletions', 0)}")
print(f"ChangedFiles: {data.get('changed_files', 0)}")
print(f"Body preview: {data.get('body', '')[:200]}")

# Check CI status
checks = subprocess.run(
    ["gh", "api", "repos/openclaw/openclaw/commits/68976/status", "--jq", "."],
    capture_output=True, text=True, encoding="utf-8"
)
status_data = json.loads(checks.stdout)
print(f"\nCI Status: {status_data.get('state', 'N/A')}")
total = status_data.get('total_count', 0)
print(f"Total checks: {total}")
for s in status_data.get('statuses', []):
    state = s.get('state', 'N/A')
    if state != 'SUCCESS':
        print(f"  FAILING: {s.get('context', 'N/A')} -> {state}")
