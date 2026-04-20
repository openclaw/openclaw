#!/usr/bin/env python3
import subprocess, json

# Check all Eruditi's PRs to openclaw/openclaw
result = subprocess.run(
    ["gh", "api", "repos/openclaw/openclaw/pulls?state=all&per_page=30"],
    capture_output=True, text=True, encoding="utf-8"
)
data = json.loads(result.stdout)
eruditi = [p for p in data if p.get("user", {}).get("login") == "Eruditi"]
print(f"Eruditi's all PRs to openclaw/openclaw: {len(eruditi)}")
for pr in eruditi:
    print(f"  #{pr['number']}: {pr['title'][:70]} [{pr['state']}] mergeable={pr.get('mergeable_state', 'N/A')}")
