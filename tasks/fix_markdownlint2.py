#!/usr/bin/env python3
"""Fix remaining 6 markdownlint errors."""
import re

# 1. qwen.zh-CN.md line 33 - MD037 spaces inside emphasis
with open("docs/providers/qwen.zh-CN.md", encoding="utf-8") as f:
    content = f.read()
lines = content.split('\n')
print(f"Line 33: {repr(lines[32])}")
print(f"Line 34: {repr(lines[33])}")
# Check line 33 for ** ** patterns
if '**' in lines[32]:
    # Find all ** patterns
    for i, line in enumerate(lines[30:36], start=31):
        if '**' in line:
            print(f"Line {i}: {repr(line)}")
    # Look for patterns like "** text **" (with spaces inside **)
    # The MD037 rule: spaces inside emphasis markers
    # e.g. "xx ** text ** yy" -> "xx **text** yy"
    # The issue is "** xxx **" where there are spaces immediately after ** and before **
    # Pattern: ** followed by space, then content, then space before **
    # Regex: \*\* ([^}]+?) \*\* -> **$1**
    fixed = re.sub(r'\*\* *([^} ]+?) *\*\*', r'**\1**', lines[32])
    print(f"After fix: {repr(fixed)}")

# 2. qwen.zh-CN.md line 164 - MD037 x3
print(f"\nLine 164: {repr(lines[163])}")
