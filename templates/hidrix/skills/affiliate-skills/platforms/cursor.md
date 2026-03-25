# Using affiliate-skills with Cursor

## Overview

Cursor reads `.cursorrules` and project files automatically when you open a folder. Because
affiliate-skills ships with a `.cursorrules` file, the skill system activates the moment you
open the repo — no extra configuration needed.

Cursor also has access to your terminal, so CLI-dependent skills like `affiliate-check` work
natively.

---

## Setup

```bash
git clone https://github.com/Affitor/affiliate-skills.git
cd affiliate-skills
```

Open the folder in Cursor:

```bash
cursor .
```

That's it. Cursor reads `.cursorrules` automatically. The skill system is active.

Optional: run the setup script to build the `affiliate-check` CLI:

```bash
./setup.sh
```

---

## Using Skills in Chat

Reference skill files directly in your Cursor chat prompt:

```
@SKILL.md Run the /blog-post skill for ConvertKit.
Commission: 30%, cookie: 60 days, audience: email marketers.
```

Or by skill path:

```
@skills/landing-page/SKILL.md Generate a landing page for the Webflow affiliate program.
```

Cursor parses the skill's step definitions and follows the workflow. For multi-step skills,
it will walk through each phase and confirm or continue automatically.

---

## affiliate-check CLI

After running `./setup.sh`, the `affiliate-check` binary is available at `./bin/affiliate-check`.

Run it from the Cursor terminal:

```bash
./bin/affiliate-check --program "notion" --url "https://notion.so/affiliates"
```

Cursor can also invoke it programmatically during an agentic run — reference it in your prompt:

```
Run ./bin/affiliate-check on this URL, then use the output to run /content-brief.
```

---

## Tips

- **Cursor Composer** (Cmd+Shift+I) is best for multi-file outputs — use it for skills that
  generate a landing page (HTML + CSS + copy) or a full blog post with frontmatter
- **@-reference skill files** by path to give Cursor the exact workflow without relying on
  `.cursorrules` alone — helpful for less common skills
- **Terminal integration**: Cursor's terminal shares the same project root, so CLI tools,
  Node scripts, and build steps in skills all work inline
- **Inline diffs**: for skills that edit existing files (e.g., `/meta-description` updating
  a frontmatter block), Cursor's diff view makes review fast

---

## Also Works With

These editors follow the same pattern — open the repo folder and reference skill files in chat:

| Editor                       | How                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- |
| **Windsurf**                 | Reads `.windsurfrules` or `.cursorrules`; open folder, use chat                   |
| **VS Code + GitHub Copilot** | Add `bootstrap.md` content to Copilot Instructions; reference `@SKILL.md` in chat |
| **Zed**                      | Paste bootstrap prompt in AI assistant panel; reference skill files by path       |

For any editor with an AI chat panel and terminal access, the pattern is the same:
load the bootstrap context, reference skill files, run CLI tools in the integrated terminal.
