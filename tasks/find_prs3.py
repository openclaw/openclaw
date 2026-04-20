#!/usr/bin/env python3
import subprocess, json

# Check all Eruditi's PRs to openclaw/openclaw
result = subprocess.run(
    ["gh", "api", "repos/openclaw/openclaw/pulls?state=all&per_page=20", "--jq", 
     "[.[] | select(.user.login == 'Eruditi') | {number, title, state, mergeable_state}]"] ,
    capture_output=True, text=True, encoding="utf-8"
)
data = json.loads(result.stdout)
print(f"Eruditi's all PRs to openclaw/openclaw: {len(data)}")
for pr in data:
    print(f"  #{pr['number']}: {pr['title'][:60]} [{pr['state']}] mergeable={pr['mergeable_state']}")
