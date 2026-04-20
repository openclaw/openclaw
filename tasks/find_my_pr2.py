#!/usr/bin/env python3
import subprocess, json

pr_numbers = [68802, 68888, 68901, 68976, 69133]
for num in pr_numbers:
    result = subprocess.run(
        ["gh", "api", f"repos/openclaw/openclaw/pulls/{num}"],
        capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode == 0:
        data = json.loads(result.stdout)
        print(f"#{num}: {data['title'][:60]} [{data['state']}] mergeable={data.get('mergeable_state','N/A')} user={data.get('user',{}).get('login')}")
    else:
        print(f"#{num}: NOT FOUND")
