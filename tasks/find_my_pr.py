#!/usr/bin/env python3
import subprocess, json

# Find Eruditi's open PRs
result = subprocess.run(
    ["gh", "api", "repos/openclaw/openclaw/pulls", "--jq", 
     "[.[] | select(.user.login == \"Eruditi\") | {number, title, state, mergeable_state, additions, changed_files}]"],
    capture_output=True, text=True, encoding="utf-8"
)
data = json.loads(result.stdout)
print(f"Eruditi's open PRs: {len(data)}")
for pr in data:
    print(f"  #{pr['number']}: {pr['title']} [{pr['state']}] mergeable={pr['mergeable_state']} files={pr['changed_files']}")
