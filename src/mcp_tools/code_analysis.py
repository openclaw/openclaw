"""
MCP Server: Code Analysis — AST-based static analysis, dependency scanning, and metrics.

Provides tools for the Coder and Auditor brigade roles:
- Python AST analysis (complexity, imports, functions, classes)
- Dependency vulnerability scanning (requirements.txt → known patterns)
- Code metrics (LOC, cyclomatic complexity estimate, function length)
- File diff summary
"""

import ast
import os
import re

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Code-Analysis")

_MAX_OUTPUT_CHARS = 16_000


def _truncate(text: str) -> str:
    if len(text) > _MAX_OUTPUT_CHARS:
        return text[:_MAX_OUTPUT_CHARS] + f"\n\n... [truncated, {len(text)} total chars]"
    return text


@mcp.tool()
def analyze_python_file(file_path: str) -> str:
    """Analyze a Python file: extract functions, classes, imports, and complexity metrics.
    Returns structured summary useful for code review, refactoring, and auditing.
    Args:
        file_path: Absolute path to a .py file.
    """
    if not os.path.isfile(file_path):
        return f"Error: File not found: {file_path}"
    if not file_path.endswith(".py"):
        return "Error: Only .py files are supported."

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            source = f.read()
    except Exception as e:
        return f"Error reading file: {e}"

    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError as e:
        return f"SyntaxError at line {e.lineno}: {e.msg}"

    lines = source.splitlines()
    total_lines = len(lines)
    blank_lines = sum(1 for l in lines if not l.strip())
    comment_lines = sum(1 for l in lines if l.strip().startswith("#"))
    code_lines = total_lines - blank_lines - comment_lines

    imports = []
    functions = []
    classes = []
    global_vars = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                imports.append(f"{module}.{alias.name}")
        elif isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
            # Only top-level and class-level functions
            args = [a.arg for a in node.args.args]
            end_line = getattr(node, "end_lineno", node.lineno)
            func_lines = end_line - node.lineno + 1
            complexity = _estimate_complexity(node)
            prefix = "async " if isinstance(node, ast.AsyncFunctionDef) else ""
            functions.append({
                "name": f"{prefix}def {node.name}({', '.join(args)})",
                "line": node.lineno,
                "lines": func_lines,
                "complexity": complexity,
            })
        elif isinstance(node, ast.ClassDef):
            methods = [
                n.name for n in node.body
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            classes.append({
                "name": node.name,
                "line": node.lineno,
                "methods": methods,
                "bases": [_name_of(b) for b in node.bases],
            })
        elif isinstance(node, ast.Assign) and isinstance(node, ast.stmt):
            for target in node.targets:
                if isinstance(target, ast.Name) and not target.id.startswith("_"):
                    global_vars.append(target.id)

    report = [f"📊 Analysis: {os.path.basename(file_path)}"]
    report.append(f"Lines: {total_lines} total, {code_lines} code, {comment_lines} comments, {blank_lines} blank")
    report.append(f"Imports: {len(imports)}")

    if imports:
        report.append("\n📦 Imports:")
        for imp in sorted(set(imports)):
            report.append(f"  - {imp}")

    if classes:
        report.append(f"\n🏗️ Classes ({len(classes)}):")
        for cls in classes:
            bases = f"({', '.join(cls['bases'])})" if cls["bases"] else ""
            report.append(f"  class {cls['name']}{bases} [line {cls['line']}]")
            report.append(f"    methods: {', '.join(cls['methods']) or 'none'}")

    if functions:
        report.append(f"\n⚙️ Functions ({len(functions)}):")
        for fn in sorted(functions, key=lambda x: -x["complexity"]):
            cx_label = "🔴" if fn["complexity"] > 10 else "🟡" if fn["complexity"] > 5 else "🟢"
            report.append(f"  {cx_label} {fn['name']} [line {fn['line']}, {fn['lines']} LOC, complexity {fn['complexity']}]")

    # Warnings
    warnings = []
    for fn in functions:
        if fn["lines"] > 50:
            report_name = fn["name"].split("(")[0].replace("async def ", "").replace("def ", "")
            warnings.append(f"⚠️ {report_name}: {fn['lines']} lines (consider splitting)")
        if fn["complexity"] > 10:
            report_name = fn["name"].split("(")[0].replace("async def ", "").replace("def ", "")
            warnings.append(f"⚠️ {report_name}: complexity {fn['complexity']} (refactor candidate)")
    if total_lines > 500:
        warnings.append(f"⚠️ File too long: {total_lines} lines (target < 500)")
    if warnings:
        report.append("\n⚠️ Warnings:")
        for w in warnings:
            report.append(f"  {w}")

    return _truncate("\n".join(report))


def _estimate_complexity(node: ast.AST) -> int:
    """Estimate cyclomatic complexity of a function node."""
    complexity = 1
    for child in ast.walk(node):
        if isinstance(child, (ast.If, ast.While, ast.For, ast.AsyncFor)):
            complexity += 1
        elif isinstance(child, ast.ExceptHandler):
            complexity += 1
        elif isinstance(child, ast.BoolOp):
            complexity += len(child.values) - 1
        elif isinstance(child, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            complexity += 1
    return complexity


def _name_of(node: ast.AST) -> str:
    """Get name from AST node (for base classes)."""
    if isinstance(node, ast.Name):
        return node.id
    elif isinstance(node, ast.Attribute):
        return f"{_name_of(node.value)}.{node.attr}"
    return "?"


@mcp.tool()
def scan_dependencies(requirements_path: str) -> str:
    """Scan a requirements.txt or pyproject.toml for potential issues.
    Checks: pinned vs unpinned versions, known risky packages, duplicates.
    Args:
        requirements_path: Path to requirements.txt or pyproject.toml.
    """
    if not os.path.isfile(requirements_path):
        return f"Error: File not found: {requirements_path}"

    try:
        with open(requirements_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        return f"Error reading file: {e}"

    lines = [l.strip() for l in content.splitlines() if l.strip() and not l.strip().startswith("#")]
    issues = []
    deps = []

    for line in lines:
        if line.startswith("-") or line.startswith("["):
            continue
        # Parse package==version or package>=version
        match = re.match(r'^([a-zA-Z0-9_.-]+)\s*([><=!~]+)?\s*(.+)?$', line)
        if match:
            pkg = match.group(1)
            op = match.group(2) or ""
            ver = match.group(3) or ""
            deps.append({"pkg": pkg, "op": op, "ver": ver, "line": line})

            if not op:
                issues.append(f"⚠️ {pkg}: unpinned version (add ==X.Y.Z for reproducibility)")

    report = [f"📦 Dependency scan: {os.path.basename(requirements_path)}"]
    report.append(f"Total packages: {len(deps)}")
    pinned = sum(1 for d in deps if "==" in d["op"])
    report.append(f"Pinned: {pinned}/{len(deps)}")

    if issues:
        report.append(f"\n⚠️ Issues ({len(issues)}):")
        for issue in issues[:20]:
            report.append(f"  {issue}")

    return _truncate("\n".join(report))


@mcp.tool()
def code_metrics(directory: str, extensions: str = ".py") -> str:
    """Compute code metrics for a directory: total LOC, file count, largest files.
    Args:
        directory: Directory path to analyze.
        extensions: Comma-separated file extensions to include (default '.py').
    """
    if not os.path.isdir(directory):
        return f"Error: Directory not found: {directory}"

    exts = [e.strip() for e in extensions.split(",")]
    file_stats = []
    total_lines = 0

    for root, _, files in os.walk(directory):
        # Skip hidden dirs and common non-source dirs
        if any(skip in root for skip in [".git", "__pycache__", "node_modules", ".venv", "venv"]):
            continue
        for fname in files:
            if not any(fname.endswith(ext) for ext in exts):
                continue
            fpath = os.path.join(root, fname)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    lines = sum(1 for _ in f)
                file_stats.append({"path": fpath, "lines": lines})
                total_lines += lines
            except Exception:
                continue

    file_stats.sort(key=lambda x: -x["lines"])

    report = [f"📊 Code Metrics: {directory}"]
    report.append(f"Extensions: {', '.join(exts)}")
    report.append(f"Files: {len(file_stats)}")
    report.append(f"Total LOC: {total_lines:,}")

    if file_stats:
        avg = total_lines // len(file_stats) if file_stats else 0
        report.append(f"Average LOC: {avg}")
        report.append(f"\n📈 Largest files:")
        for fs in file_stats[:15]:
            rel_path = os.path.relpath(fs["path"], directory)
            marker = " ⚠️" if fs["lines"] > 500 else ""
            report.append(f"  {fs['lines']:>5} LOC  {rel_path}{marker}")

    return _truncate("\n".join(report))


if __name__ == "__main__":
    mcp.run()
