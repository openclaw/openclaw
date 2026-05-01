---
name: bootstrap-extra-files
description: "Inject additional workspace bootstrap files via glob/path patterns"
homepage: https://docs.openclaw.ai/automation/hooks#bootstrap-extra-files
metadata:
  {
    "openclaw":
      {
        "emoji": "📎",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Bootstrap Extra Files Hook

Loads additional bootstrap files into `Project Context` during `agent:bootstrap`.

## Why

Use this when your workspace has multiple context roots (for example monorepos) and
you want to include extra project context files without changing the
workspace root.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/PROJECT.md"]
        }
      }
    }
  }
}
```

## Options

- `paths` (string[]): preferred list of glob/path patterns.
- `patterns` (string[]): alias of `paths`.
- `files` (string[]): alias of `paths`.

All paths are resolved from the workspace and must stay inside it (including realpath checks).
Matching files are loaded into Project Context and remain subject to the same per-file and
total bootstrap prompt budgets as the default workspace bootstrap files.
