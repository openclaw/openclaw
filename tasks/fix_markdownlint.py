#!/usr/bin/env python3
"""Fix all 13 remaining markdownlint errors in zh-CN docs."""
import re
import os

DOCS = "docs"

def fix_file(path, fixes):
    with open(path, encoding="utf-8") as f:
        content = f.read()
    lines = content.split('\n')
    for (line_num, old, new) in fixes:
        idx = line_num - 1
        if idx < len(lines) and lines[idx] == old:
            lines[idx] = new
            print(f"  FIXED {path}:{line_num}")
        else:
            # Try partial match
            print(f"  WARN {path}:{line_num}: expected {repr(old[:50])} but got {repr(lines[idx] if idx < len(lines) else 'EOF')}")
    content = '\n'.join(lines)
    # Ensure trailing newline
    if not content.endswith('\n'):
        content += '\n'
    with open(path, 'w', encoding="utf-8", newline='\n') as f:
        f.write(content)

# 1. docs/plugins/architecture.zh-CN.md:91 - MD026 trailing punctuation in heading
# Line is: ### 遗留钩子`before_agent_start`钩子作为仅钩子插件的兼容路径仍然受支持。遗留的真实世界插件仍然依赖它。
# Fix: split heading from description, remove trailing 。
old91 = "### 遗留钩子`before_agent_start`钩子作为仅钩子插件的兼容路径仍然受支持。遗留的真实世界插件仍然依赖它。"
new91 = "### 遗留钩子\n\n`before_agent_start` 钩子作为仅钩子插件的兼容路径仍然受支持。遗留的真实世界插件仍然依赖它"
fix_file(f"{DOCS}/plugins/architecture.zh-CN.md", [(91, old91, new91)])

# 2. docs/plugins/manifest.zh-CN.md:35 - MD026 trailing punctuation
old35 = "### 清单格式（JSON5）"
# Read the file to find the exact line
with open(f"{DOCS}/plugins/manifest.zh-CN.md", encoding="utf-8") as f:
    lines_m = f.read().split('\n')
# Check line 35
if lines_m[34].endswith('。'):
    lines_m[34] = lines_m[34][:-1]  # Remove trailing 。
    with open(f"{DOCS}/plugins/manifest.zh-CN.md", 'w', encoding="utf-8") as f:
        f.write('\n'.join(lines_m))
    print(f"  FIXED {DOCS}/plugins/manifest.zh-CN.md:35")
else:
    print(f"  WARN {DOCS}/plugins/manifest.zh-CN.md:35: {repr(lines_m[34])}")

# 3. docs/plugins/manifest.zh-CN.md:112 - MD033 inline HTML <key>
# Replace <key> with `key` (inline code)
with open(f"{DOCS}/plugins/manifest.zh-CN.md", encoding="utf-8") as f:
    content_m = f.read()
if '<key>' in content_m:
    count = content_m.count('<key>')
    content_m = content_m.replace('<key>', '`key`')
    with open(f"{DOCS}/plugins/manifest.zh-CN.md", 'w', encoding="utf-8") as f:
        f.write(content_m)
    print(f"  FIXED {DOCS}/plugins/manifest.zh-CN.md: replaced {count}x <key> with `key`")
else:
    print(f"  WARN <key> not found in manifest.zh-CN.md")

# 4. docs/prose.zh-CN.md - MD026 trailing punctuation on headings
with open(f"{DOCS}/prose.zh-CN.md", encoding="utf-8") as f:
    lines_p = f.read().split('\n')
for i in [40, 82]:  # 0-indexed: lines 41 and 83
    if lines_p[i].endswith('。'):
        lines_p[i] = lines_p[i][:-1]
        print(f"  FIXED {DOCS}/prose.zh-CN.md:{i+1}")
    else:
        print(f"  WARN {DOCS}/prose.zh-CN.md:{i+1}: {repr(lines_p[i][-20:])}")
with open(f"{DOCS}/prose.zh-CN.md", 'w', encoding="utf-8") as f:
    f.write('\n'.join(lines_p))

# 5. docs/channels/slack.zh-CN.md:823 - MD051 link fragment
# Fix: change #additional-manifest-settings to #additional-manifest-settings or #其他清单设置
with open(f"{DOCS}/channels/slack.zh-CN.md", encoding="utf-8") as f:
    content_s = f.read()
if '#additional-manifest-settings' in content_s:
    # The heading is "其他清单设置" which slugs to #其他清单设置
    content_s = content_s.replace('[其他清单设置](#additional-manifest-settings)', '[其他清单设置](#其他清单设置)')
    with open(f"{DOCS}/channels/slack.zh-CN.md", 'w', encoding="utf-8") as f:
        f.write(content_s)
    print(f"  FIXED {DOCS}/channels/slack.zh-CN.md:823 link fragment")
else:
    print(f"  WARN link fragment not found in slack.zh-CN.md")

# 6. docs/channels/tlon.zh-CN.md:230 - MD051 link fragment
# Fix: change #bundled-skill to #捆绑技能
with open(f"{DOCS}/channels/tlon.zh-CN.md", encoding="utf-8") as f:
    content_t = f.read()
if '#bundled-skill' in content_t:
    content_t = content_t.replace('[捆绑技能](#bundled-skill)', '[捆绑技能](#捆绑技能)')
    with open(f"{DOCS}/channels/tlon.zh-CN.md", 'w', encoding="utf-8") as f:
        f.write(content_t)
    print(f"  FIXED {DOCS}/channels/tlon.zh-CN.md:230 link fragment")
else:
    print(f"  WARN link fragment not found in tlon.zh-CN.md")

# 7. docs/providers/qwen.zh-CN.md - MD037 spaces inside emphasis markers
with open(f"{DOCS}/providers/qwen.zh-CN.md", encoding="utf-8") as f:
    content_q = f.read()
# Spaces inside ** ** markers: ** xxx ** or ** xxx** or **xxx **
# Fix: remove spaces inside emphasis
# Pattern: (em markers with spaces inside)
# e.g. "** xxx **" -> "**xxx**"
# e.g. "** xxx**" -> "**xxx**"
# e.g. "**xxx **" -> "**xxx**"
fixed_q = re.sub(r'\*\* \*\*', '**', fixed_q := content_q)
# Better regex for MD037: ** with spaces immediately inside
fixed_q2 = re.sub(r'\*\* \*([^\*]+)\*\*', r'**\1**', content_q)
fixed_q3 = re.sub(r'\*\*([^\*]+) \*\*', r'**\1**', content_q)
if fixed_q2 != content_q or fixed_q3 != content_q:
    with open(f"{DOCS}/providers/qwen.zh-CN.md", 'w', encoding="utf-8") as f:
        f.write(fixed_q3)
    print(f"  FIXED {DOCS}/providers/qwen.zh-CN.md: MD037 emphasis spaces")
else:
    print(f"  WARN no changes in qwen.zh-CN.md")

print("\nDone!")
