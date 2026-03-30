"""Graph-RAG — Dependency graph engine for project-aware retrieval.

Builds and queries a directed graph of file dependencies so the agent
understands that changing api_client.py may impact order_manager.py
even without a direct import relationship.

Supports:
- AST-based import parsing (Python)
- Regex-based import parsing (TypeScript/Rust)
- Transitive dependency resolution (N-hop)
- Impact analysis: "which files are affected by changing X?"
- Graph-augmented RAG: include dependency context in retrieval

Reference: Graph-based Memory research collected in data/research/v11.6.
"""

from __future__ import annotations

import ast
import os
import re
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple

import structlog

logger = structlog.get_logger("GraphRAG")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class FileNode:
    """A node in the dependency graph."""
    path: str  # relative to project root
    language: str = "unknown"  # python | typescript | rust
    imports: List[str] = field(default_factory=list)
    imported_by: List[str] = field(default_factory=list)
    symbols: List[str] = field(default_factory=list)  # exported names


@dataclass
class ImpactResult:
    """Result of an impact analysis query."""
    source_file: str
    directly_affected: List[str]
    transitively_affected: List[str]
    total_affected: int
    max_depth: int


@dataclass
class GraphStats:
    """Summary statistics for the dependency graph."""
    total_files: int
    total_edges: int
    languages: Dict[str, int]
    most_imported: List[Tuple[str, int]]  # top files by in-degree
    most_dependent: List[Tuple[str, int]]  # top files by out-degree


# ---------------------------------------------------------------------------
# Import parsers
# ---------------------------------------------------------------------------

def _parse_python_imports(file_path: str, content: str) -> List[str]:
    """Extract imports from a Python file using AST."""
    imports: List[str] = []
    try:
        tree = ast.parse(content, filename=file_path)
    except SyntaxError:
        return _parse_python_imports_regex(content)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.append(node.module)
    return imports


def _parse_python_imports_regex(content: str) -> List[str]:
    """Fallback regex parser for Python imports."""
    imports: List[str] = []
    for m in re.finditer(r"^\s*(?:from|import)\s+([\w.]+)", content, re.MULTILINE):
        imports.append(m.group(1))
    return imports


_TS_IMPORT_RE = re.compile(
    r"""(?:import|from)\s+['"]([^'"]+)['"]"""
    r"""|require\s*\(\s*['"]([^'"]+)['"]\s*\)""",
    re.MULTILINE,
)


def _parse_ts_imports(content: str) -> List[str]:
    """Extract imports from a TypeScript/JavaScript file."""
    imports: List[str] = []
    for m in _TS_IMPORT_RE.finditer(content):
        imp = m.group(1) or m.group(2)
        if imp:
            imports.append(imp)
    return imports


_RUST_USE_RE = re.compile(r"^\s*(?:use|mod)\s+([\w:]+)", re.MULTILINE)


def _parse_rust_imports(content: str) -> List[str]:
    """Extract use/mod from a Rust file."""
    return [m.group(1) for m in _RUST_USE_RE.finditer(content)]


_LANG_EXTENSIONS: Dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".rs": "rust",
}


def _detect_language(file_path: str) -> str:
    ext = Path(file_path).suffix.lower()
    return _LANG_EXTENSIONS.get(ext, "unknown")


def _parse_imports(file_path: str, content: str) -> List[str]:
    lang = _detect_language(file_path)
    if lang == "python":
        return _parse_python_imports(file_path, content)
    elif lang in ("typescript", "javascript"):
        return _parse_ts_imports(content)
    elif lang == "rust":
        return _parse_rust_imports(content)
    return []


# ---------------------------------------------------------------------------
# Graph Engine
# ---------------------------------------------------------------------------

_SKIP_DIRS: FrozenSet[str] = frozenset([
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    "dist", "build", ".tox", ".mypy_cache", "target",
])

_MAX_FILE_SIZE = 512 * 1024  # 512 KB


class DependencyGraphEngine:
    """Build and query a file dependency graph for a project.

    Usage:
        engine = DependencyGraphEngine(project_root="/path/to/project")
        engine.build()
        impact = engine.impact_analysis("src/api_client.py", max_depth=3)
    """

    def __init__(self, project_root: str):
        self.project_root = os.path.abspath(project_root)
        self.nodes: Dict[str, FileNode] = {}
        self._adjacency: Dict[str, Set[str]] = defaultdict(set)       # file -> imports
        self._reverse_adj: Dict[str, Set[str]] = defaultdict(set)     # file -> imported_by
        self._built = False

    def build(self, sub_dirs: Optional[List[str]] = None) -> GraphStats:
        """Scan the project and build the dependency graph.

        Args:
            sub_dirs: optional list of subdirectories to scan
                      (relative to project_root). Default: scan entire root.
        """
        start = time.monotonic()
        self.nodes.clear()
        self._adjacency.clear()
        self._reverse_adj.clear()

        roots = [os.path.join(self.project_root, d) for d in sub_dirs] if sub_dirs else [self.project_root]

        for root_dir in roots:
            self._scan_directory(root_dir)

        self._resolve_edges()
        self._built = True

        elapsed = time.monotonic() - start
        stats = self.stats()
        logger.info(
            "graph_built",
            files=stats.total_files,
            edges=stats.total_edges,
            elapsed_sec=round(elapsed, 2),
        )
        return stats

    def impact_analysis(self, file_path: str, max_depth: int = 3) -> ImpactResult:
        """Determine which files are affected by changes to file_path."""
        rel = self._normalize(file_path)
        if rel not in self.nodes:
            return ImpactResult(
                source_file=rel,
                directly_affected=[],
                transitively_affected=[],
                total_affected=0,
                max_depth=0,
            )

        direct = sorted(self._reverse_adj.get(rel, set()))
        transitive = self._bfs_reverse(rel, max_depth)
        transitive -= {rel}
        transitive -= set(direct)

        return ImpactResult(
            source_file=rel,
            directly_affected=direct,
            transitively_affected=sorted(transitive),
            total_affected=len(direct) + len(transitive),
            max_depth=max_depth,
        )

    def get_context_for_rag(self, file_path: str, depth: int = 2) -> List[str]:
        """Return related file paths to include in RAG context."""
        rel = self._normalize(file_path)
        related: Set[str] = set()

        # Forward dependencies (what this file imports)
        related.update(self._adjacency.get(rel, set()))

        # Reverse dependencies (what imports this file)
        related.update(self._reverse_adj.get(rel, set()))

        # Transitive (depth > 1)
        if depth > 1:
            for neighbor in list(related):
                related.update(self._adjacency.get(neighbor, set()))
                related.update(self._reverse_adj.get(neighbor, set()))

        related.discard(rel)
        return sorted(related)

    def get_enriched_context(
        self,
        file_path: str,
        depth: int = 2,
        knowledge_tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Return graph context enriched with knowledge store entries.

        Combines dependency-graph neighbours with semantic knowledge
        relevant to the file's language (Python 3.14 / Rust 2024).
        """
        from src.memory.knowledge_store import KnowledgeStore

        related_files = self.get_context_for_rag(file_path, depth=depth)

        # Auto-detect relevant knowledge tags from file language
        if knowledge_tags is None:
            knowledge_tags = []
            lang = _detect_language(file_path)
            if lang == "python":
                knowledge_tags.append("STANDARD_LIBRARY_PY314")
            elif lang == "rust":
                knowledge_tags.append("RUST_STABLE_2026")
            elif lang in ("typescript", "javascript"):
                knowledge_tags.append("TYPESCRIPT_MODERN_58")

        knowledge_context = ""
        if knowledge_tags:
            store = KnowledgeStore(self.project_root)
            store.build()
            knowledge_context = store.get_context_for_prompt(knowledge_tags)

        return {
            "file": self._normalize(file_path),
            "related_files": related_files,
            "knowledge_context": knowledge_context,
        }

    def stats(self) -> GraphStats:
        """Return summary statistics."""
        lang_counts: Dict[str, int] = defaultdict(int)
        for node in self.nodes.values():
            lang_counts[node.language] += 1

        in_degree = [(f, len(deps)) for f, deps in self._reverse_adj.items()]
        in_degree.sort(key=lambda x: x[1], reverse=True)

        out_degree = [(f, len(deps)) for f, deps in self._adjacency.items()]
        out_degree.sort(key=lambda x: x[1], reverse=True)

        return GraphStats(
            total_files=len(self.nodes),
            total_edges=sum(len(v) for v in self._adjacency.values()),
            languages=dict(lang_counts),
            most_imported=in_degree[:10],
            most_dependent=out_degree[:10],
        )

    # ------------------------------------------------------------------
    # Private: scanning and edge resolution
    # ------------------------------------------------------------------

    def _scan_directory(self, root_dir: str) -> None:
        """Walk directory tree and parse each supported file."""
        for dirpath, dirnames, filenames in os.walk(root_dir):
            # Prune skip dirs in-place
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]

            for fname in filenames:
                full = os.path.join(dirpath, fname)
                lang = _detect_language(fname)
                if lang == "unknown":
                    continue

                try:
                    size = os.path.getsize(full)
                    if size > _MAX_FILE_SIZE:
                        continue
                    with open(full, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                except OSError:
                    continue

                rel = os.path.relpath(full, self.project_root).replace("\\", "/")
                imports = _parse_imports(full, content)

                self.nodes[rel] = FileNode(
                    path=rel,
                    language=lang,
                    imports=imports,
                )

    def _resolve_edges(self) -> None:
        """Convert import module names to actual graph edges."""
        all_files = set(self.nodes.keys())
        # Build lookup: module name -> file path
        module_to_file: Dict[str, str] = {}
        for fpath in all_files:
            # Python: src/api_client.py -> src.api_client
            mod = fpath.replace("/", ".").replace("\\", ".")
            if mod.endswith(".py"):
                mod = mod[:-3]
            module_to_file[mod] = fpath
            # Also index just the filename stem
            stem = Path(fpath).stem
            if stem not in module_to_file:
                module_to_file[stem] = fpath

        for fpath, node in self.nodes.items():
            for imp in node.imports:
                # Try direct module match
                target = module_to_file.get(imp)
                if not target:
                    # Try relative path resolution
                    target = module_to_file.get(imp.replace(".", "/"))
                if not target:
                    # Try partial match (last segment)
                    parts = imp.split(".")
                    target = module_to_file.get(parts[-1]) if parts else None

                if target and target != fpath:
                    self._adjacency[fpath].add(target)
                    self._reverse_adj[target].add(fpath)
                    node.imports  # keep raw imports for reference

    def _bfs_reverse(self, start: str, max_depth: int) -> Set[str]:
        """BFS on reverse adjacency to find transitively affected files."""
        visited: Set[str] = set()
        queue: deque[Tuple[str, int]] = deque([(start, 0)])

        while queue:
            node, depth = queue.popleft()
            if node in visited:
                continue
            visited.add(node)

            if depth >= max_depth:
                continue

            for neighbor in self._reverse_adj.get(node, set()):
                if neighbor not in visited:
                    queue.append((neighbor, depth + 1))

        return visited

    def _normalize(self, file_path: str) -> str:
        """Normalize file path to relative posix form."""
        if os.path.isabs(file_path):
            return os.path.relpath(file_path, self.project_root).replace("\\", "/")
        return file_path.replace("\\", "/")
