#!/usr/bin/env python3
import subprocess, json

result = subprocess.run(
    ["gh", "api", "repos/openclaw/openclaw/pulls?per_page=30"],
    capture_output=True, text=True, encoding="utf-8"
)
data = json.loads(result.stdout)
print(f"Total open PRs: {len(data)}")
for p in data:
    login = p.get("user", {}).get("login", "?")
    print(f"  #{p['number']} by {login}: {p['title'][:60]}")
