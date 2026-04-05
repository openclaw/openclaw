"""Codebase dump generators — export source code into NotebookLM-compatible Markdown."""

import os

_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_LANG_MAP = {
    ".py": "python", ".rs": "rust", ".ts": "typescript", ".js": "javascript",
    ".toml": "toml", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".md": "markdown", ".sh": "bash", ".ps1": "powershell", ".sql": "sql",
    ".html": "html", ".css": "css", ".mjs": "javascript",
}

_IGNORE_DIRS = {
    ".venv", "__pycache__", ".git", ".pytest_cache", ".obsidian",
    "node_modules", ".mypy_cache", ".ruff_cache", "target",
    "dist", ".tox",
}

_IGNORE_EXTS = {
    ".pyc", ".pyo", ".so", ".pyd", ".dll", ".exe", ".whl",
    ".egg-info", ".tar", ".gz", ".zip", ".png", ".jpg", ".jpeg",
    ".gif", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".lock",
}

_IGNORE_FILES = {".env", ".env.local", ".env.production", "pnpm-lock.yaml"}


def _should_skip_dir(name: str) -> bool:
    return name in _IGNORE_DIRS or name.startswith(".")


def _should_skip_file(name: str) -> bool:
    if name in _IGNORE_FILES:
        return True
    _, ext = os.path.splitext(name)
    return ext in _IGNORE_EXTS


def _anchor(rel: str) -> str:
    return rel.replace("/", "-").replace("\\", "-").replace(".", "-").replace("_", "-").lower()


def _lang(path: str) -> str:
    _, ext = os.path.splitext(path)
    return _LANG_MAP.get(ext, "")


def export_openclaw_codebase() -> str:
    """Recursively export src/, scripts/ and root config files into a single Markdown file."""
    scan_dirs = [
        os.path.join(_project_root, "src"),
        os.path.join(_project_root, "scripts"),
    ]
    root_names = {"SOUL.md", "IDENTITY.md", "BRAIN.md", "MEMORY.md", "VISION.md",
                  "HEARTBEAT.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md",
                  "README.md", "TROUBLESHOOTING.md", "PROJECT_CONTEXT.md",
                  "pyproject.toml", "tsconfig.json", "vitest.config.ts",
                  "tsdown.config.ts", "docker-compose.yml", "Dockerfile",
                  "fly.toml", "render.yaml", "openclaw.mjs", "package.json"}

    toc: list[str] = []
    sections: list[str] = []
    file_count = 0
    total_bytes = 0

    def _add_file(abs_path: str, rel_path: str) -> None:
        nonlocal file_count, total_bytes
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception:
            return
        rel_unix = rel_path.replace("\\", "/")
        anchor = _anchor(rel_unix)
        lang = _lang(rel_unix)
        toc.append(f"- [{rel_unix}](#{anchor})")
        sections.append(f"## File: {rel_unix}\n\n```{lang}\n{content.rstrip()}\n```")
        file_count += 1
        total_bytes += len(content)

    # 1. Root config files
    for name in sorted(os.listdir(_project_root)):
        full = os.path.join(_project_root, name)
        if not os.path.isfile(full):
            continue
        if name in root_names:
            _add_file(full, name)

    # 2. Recursive scan of src/ and scripts/
    for scan_dir in scan_dirs:
        if not os.path.isdir(scan_dir):
            continue
        for root, dirs, files in os.walk(scan_dir):
            dirs[:] = [d for d in sorted(dirs) if not _should_skip_dir(d)]
            for fname in sorted(files):
                if _should_skip_file(fname):
                    continue
                abs_path = os.path.join(root, fname)
                rel_path = os.path.relpath(abs_path, _project_root)
                _add_file(abs_path, rel_path)

    if not sections:
        return "No source files found."

    header = (
        "# OpenClaw Codebase Dump\n\n"
        f"> Auto-generated · {file_count} files · {total_bytes:,} bytes\n\n"
        "## Table of Contents\n\n"
    )
    body = header + "\n".join(toc) + "\n\n---\n\n" + "\n\n---\n\n".join(sections) + "\n"

    dump_path = os.path.join(_project_root, "OpenClaw_Codebase_Dump.md")
    with open(dump_path, "w", encoding="utf-8") as f:
        f.write(body)

    return body


# ---------------------------------------------------------------------------
# Compact bot-only dump (Python sources only, NotebookLM-compatible)
# ---------------------------------------------------------------------------
_BOT_ROOT_DOCS = {
    "SOUL.md", "IDENTITY.md", "BRAIN.md", "MEMORY.md", "VISION.md",
    "HEARTBEAT.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md",
    "README.md", "TROUBLESHOOTING.md", "PROJECT_CONTEXT.md",
    "pyproject.toml", "requirements.txt", "docker-compose.yml", "Dockerfile",
}


def export_bot_codebase_compact() -> str:
    """Export only the Python bot sources into a NotebookLM-friendly Markdown.

    Scanned paths:
      - Root docs/configs listed in _BOT_ROOT_DOCS
      - src/*.py          — all top-level Python modules
      - src/pipeline/*.py — pipeline engine modules
      - tests/*.py        — unit test suite

    Output: OpenClaw_Bot_Dump.md at project root (~100-200 KB, <200 000 words).
    """
    toc: list[str] = []
    sections: list[str] = []
    file_count = 0
    total_bytes = 0

    def _add_file(abs_path: str, rel_path: str) -> None:
        nonlocal file_count, total_bytes
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception:
            return
        rel_unix = rel_path.replace("\\", "/")
        anchor = _anchor(rel_unix)
        lang = _lang(rel_unix)
        toc.append(f"- [{rel_unix}](#{anchor})")
        sections.append(f"## File: {rel_unix}\n\n```{lang}\n{content.rstrip()}\n```")
        file_count += 1
        total_bytes += len(content)

    # 1. Root docs
    for name in sorted(os.listdir(_project_root)):
        full = os.path.join(_project_root, name)
        if os.path.isfile(full) and name in _BOT_ROOT_DOCS:
            _add_file(full, name)

    # 2. src/*.py (top-level only)
    src_dir = os.path.join(_project_root, "src")
    if os.path.isdir(src_dir):
        for name in sorted(os.listdir(src_dir)):
            if name.endswith(".py"):
                _add_file(os.path.join(src_dir, name), f"src/{name}")

    # 3. src/pipeline/*.py
    pipe_dir = os.path.join(src_dir, "pipeline")
    if os.path.isdir(pipe_dir):
        for name in sorted(os.listdir(pipe_dir)):
            if name.endswith(".py"):
                _add_file(os.path.join(pipe_dir, name), f"src/pipeline/{name}")

    # 4. src/safety/*.py
    safety_dir = os.path.join(src_dir, "safety")
    if os.path.isdir(safety_dir):
        for name in sorted(os.listdir(safety_dir)):
            if name.endswith(".py"):
                _add_file(os.path.join(safety_dir, name), f"src/safety/{name}")

    # 5. tests/*.py
    tests_dir = os.path.join(_project_root, "tests")
    if os.path.isdir(tests_dir):
        for name in sorted(os.listdir(tests_dir)):
            if name.endswith(".py"):
                _add_file(os.path.join(tests_dir, name), f"tests/{name}")

    if not sections:
        return "No source files found."

    header = (
        "# OpenClaw Bot Dump (Python Only)\n\n"
        f"> Auto-generated · {file_count} files · {total_bytes:,} bytes\n\n"
        "## Table of Contents\n\n"
    )
    body = header + "\n".join(toc) + "\n\n---\n\n" + "\n\n---\n\n".join(sections) + "\n"

    dump_path = os.path.join(_project_root, "OpenClaw_Bot_Dump.md")
    with open(dump_path, "w", encoding="utf-8") as f:
        f.write(body)

    return body
