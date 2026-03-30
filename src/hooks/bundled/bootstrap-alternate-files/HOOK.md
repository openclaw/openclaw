---
name: bootstrap-alternate-files
description: "Override workspace bootstrap files with content from external sources"
homepage: https://docs.openclaw.ai/automation/hooks#bootstrap-alternate-files
metadata:
  {
    "openclaw":
      {
        "emoji": "🔄",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Bootstrap Alternate Files Hook

Replaces workspace bootstrap file slots with content read from external sources (for example
Dropbox-backed shared files). Useful when core persona/identity files live outside the workspace
root and cannot be symlinked due to boundary restrictions.

## Why

OpenClaw's workspace loader enforces a strict boundary: files must resolve canonically inside
the workspace root. Symlinks to external locations (cloud storage, shared directories) are
rejected and show as `[MISSING]` in Project Context.

This hook runs after the workspace loader and replaces missing (or present) slots in-place
with content from explicitly configured external paths. Because the paths are provided by the
operator in configuration, this is an intentional, auditable escape hatch rather than a
general boundary weakening.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-alternate-files": {
          "enabled": true,
          "files": {
            "SOUL.md": "~/Library/CloudStorage/Dropbox/openclaw-shared/SOUL.md",
            "IDENTITY.md": "~/Library/CloudStorage/Dropbox/openclaw-shared/IDENTITY.md"
          }
        }
      }
    }
  }
}
```

## Options

- `files` (object): map of bootstrap slot name → absolute source path.
  - Keys must be recognized bootstrap basenames (`AGENTS.md`, `SOUL.md`, `TOOLS.md`,
    `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`, `memory.md`).
  - Values are paths resolved via `~` expansion. Relative paths are not supported.
  - Source files are read directly; no workspace boundary check is applied.
  - If a source file is unreadable (missing, permission error, cloud storage unavailable),
    the existing workspace entry is left unchanged and a warning is logged.

## Behaviour

- Replaces slots **in-place**: position in the injected context is preserved.
- Replaces both present and missing workspace entries.
- Does not append duplicates.
- On any per-file error, falls back gracefully rather than failing the whole hook.
- Hardlink protection: source paths that are hardlinks to other files are accepted
  (unlike the workspace loader which rejects hardlinks). The source path is
  operator-configured and therefore trusted.

## Notes

- `files` keys that do not match a recognized bootstrap basename are skipped with a warning.
- Source path `~` is expanded to the process home directory.
- This hook does not write anything to disk; context is modified in-memory only.
