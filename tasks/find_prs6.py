#!/usr/bin/env python3
import subprocess, json

# Check merged PRs from Eruditi
result = subprocess.run(
    ["gh", "api", "repos/openclaw/openclaw/pulls?state=closed&per_page=100"],
    capture_output=True, text=True, encoding="utf-8"
)
data = json.loads(result.stdout)
eruditi = [p for p in data if p.get("user", {}).get("login") == "Eruditi"]
print(f"Eruditi's closed PRs to openclaw/openclaw: {len(eruditi)}")
for pr in eruditi[:10]:
    merged = pr.get("merged_at")
    print(f"  #{pr['number']}: {pr['title'][:70]} [{pr['state']}] merged={bool(merged)}")
