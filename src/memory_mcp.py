import asyncio
import json
import math
import os
import re
import subprocess
import sys
from collections import Counter
from typing import Any, Dict, List, Optional

# Ensure project root is on sys.path for subprocess execution
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import structlog
import aiohttp
from mcp.server.fastmcp import FastMCP

# MCP uses stdio for JSON-RPC — redirect structlog to stderr so log lines
# don't corrupt the protocol transport.
structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
)

from src.llm_gateway import route_llm, is_cloud_only

# Auto-configure gateway when running as MCP subprocess
def _ensure_gateway_configured():
    """Configure llm_gateway from config if not already done (subprocess context)."""
    try:
        import src.llm_gateway as _gw
        if _gw._configured:
            return
        cfg_path = os.path.join(_project_root, "config", "openclaw_config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r") as f:
                cfg = json.loads(os.path.expandvars(f.read()))
            _gw.configure(cfg)
    except Exception:
        pass

_ensure_gateway_configured()

mcp = FastMCP("Memory Hybrid Search")

# Configuration
MEMORY_BANK_DIR = os.path.join(os.getcwd(), ".memory-bank")
HOT_MEMORY = os.path.join(MEMORY_BANK_DIR, "Hot_Memory.md")
DOMAIN_EXPERTS = os.path.join(MEMORY_BANK_DIR, "Domain_Experts.md")
COLD_MEMORY = os.path.join(MEMORY_BANK_DIR, "Cold_Memory.md")

CONFIG_PATH = "config/openclaw_config.json"
KNOWLEDGE_DIR = os.path.join(MEMORY_BANK_DIR, "knowledge")
def get_config_vllm_url():
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r") as f:
                cfg = json.loads(os.path.expandvars(f.read()))
                return cfg.get("system", {}).get("vllm_base_url", "http://localhost:8000/v1")
    except Exception:
        pass
    return "http://localhost:8000/v1"

VLLM_URL = os.environ.get("VLLM_BASE_URL", get_config_vllm_url()).rstrip("/")

INDEX_FILE = os.path.join(MEMORY_BANK_DIR, "embeddings.json")


def _get_running_model() -> str:
    """Read the active generative model name from config (needed for chat/completions reranking)."""
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r") as f:
                cfg = json.loads(os.path.expandvars(f.read()))
            return cfg.get("system", {}).get("model_router", {}).get("general",
                                                                        "meta-llama/llama-3.3-70b-instruct:free")
    except Exception:
        pass
    return "meta-llama/llama-3.3-70b-instruct:free"

async def get_embeddings(text: str) -> List[float]:
    """Get embeddings for a text snippet using vLLM /embeddings endpoint.
    Returns [] if cloud-only mode is active or the running model doesn't support embeddings.
    In that case vector_search() falls back to TF-IDF search automatically.
    """
    if is_cloud_only():
        return []  # Cloud-only: no local vLLM, use TF-IDF fallback
    try:
        async with aiohttp.ClientSession(trust_env=False) as session:
            async with session.post(f"{VLLM_URL}/embeddings", json={
                "model": _get_running_model(),
                "input": text,
            }, timeout=aiohttp.ClientTimeout(total=10), proxy=None) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("data", [{}])[0].get("embedding", [])
    except Exception:
        pass
    return []

def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    """Dot-product cosine similarity (assumes pre-normalized vectors)."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    return sum(a * b for a, b in zip(v1, v2))


def _tfidf_search(query: str, memory_files: List[str], top_k: int = 5) -> List[str]:
    """Pure-Python TF-IDF cosine similarity search over memory file sections.
    Used as a fallback when vLLM embeddings endpoint is not available
    (e.g., when serving a causal LM instead of a dedicated embedding model).
    """
    query_terms = re.findall(r'\b\w+\b', query.lower())
    if not query_terms:
        return []

    # ── Collect text chunks (split on markdown headers or every ~300 words) ──
    chunks: List[str] = []
    for fpath in memory_files:
        if not os.path.exists(fpath):
            continue
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                content = f.read()
            sections = re.split(r'(?m)^#{1,3} ', content)
            for sec in sections:
                sec = sec.strip()
                if len(sec) > 30:
                    chunks.append(sec[:600])   # cap per-chunk size
        except Exception:
            pass

    if not chunks:
        return []

    # ── Compute TF vectors and IDF over query terms only (efficient) ──
    def tf_counter(text: str) -> Counter:
        return Counter(re.findall(r'\b\w+\b', text.lower()))

    chunk_tfs = [tf_counter(c) for c in chunks]
    n = len(chunks)
    query_term_set = set(query_terms)

    # IDF: how many chunks contain each query term
    doc_freq: Counter = Counter()
    for vec in chunk_tfs:
        for term in query_term_set:
            if term in vec:
                doc_freq[term] += 1

    idf = {t: math.log((n + 1) / (doc_freq.get(t, 0) + 1)) + 1.0 for t in query_term_set}

    # Query TF-IDF vector
    q_tf = tf_counter(query)
    q_tfidf = {t: q_tf[t] * idf[t] for t in query_term_set}
    q_norm = math.sqrt(sum(v ** 2 for v in q_tfidf.values())) or 1.0

    # Score every chunk
    scored: List[tuple] = []
    for i, chunk in enumerate(chunks):
        vec = chunk_tfs[i]
        dot = sum(vec.get(t, 0) * idf[t] * q_tfidf[t] for t in query_term_set)
        if dot == 0:
            continue
        chunk_norm = math.sqrt(sum((vec.get(t, 0) * idf[t]) ** 2 for t in query_term_set)) or 1.0
        score = dot / (q_norm * chunk_norm)
        scored.append((score, chunk))

    scored.sort(reverse=True)
    return [text for _, text in scored[:top_k]]

async def vector_search(query: str, tier: str, top_k: int = 5) -> List[str]:
    """Semantic search: tries pre-built dense-embedding index first, then falls back
    to pure-Python TF-IDF search over memory files when the embedding endpoint is
    unavailable (e.g., when vLLM is serving a causal LM without --task embed).
    """
    # ── Path 1: dense-embedding index (populated by scripts/index_memory.py) ──
    query_vec = await get_embeddings(query)
    if query_vec and os.path.exists(INDEX_FILE):
        try:
            with open(INDEX_FILE, "r", encoding="utf-8") as f:
                index = json.load(f)
            results = []
            for _sid, data in index.items():
                if tier != "all" and data.get("tier") != tier:
                    continue
                sim = cosine_similarity(query_vec, data.get("vector", []))
                results.append((sim, data.get("text", "")))
            results.sort(reverse=True)
            if results:
                best_sim = results[0][0]
                threshold = max(0.3, best_sim * 0.6) if best_sim > 0.7 else 0.3
                filtered = [t for s, t in results if s >= threshold]
                return filtered[:top_k]
        except Exception:
            pass

    # ── Path 2: TF-IDF fallback (no extra dependencies, works with causal LMs) ──
    tier_files = {
        "hot": [HOT_MEMORY],
        "domain": [DOMAIN_EXPERTS],
        "cold": [COLD_MEMORY],
        "knowledge": [],
        "all": [HOT_MEMORY, DOMAIN_EXPERTS, COLD_MEMORY],
    }
    files = tier_files.get(tier, [HOT_MEMORY, DOMAIN_EXPERTS, COLD_MEMORY])
    if tier == "knowledge" and os.path.isdir(KNOWLEDGE_DIR):
        files = [os.path.join(KNOWLEDGE_DIR, f)
                 for f in os.listdir(KNOWLEDGE_DIR) if f.endswith(".md")]
    elif tier == "all" and os.path.isdir(KNOWLEDGE_DIR):
        files += [os.path.join(KNOWLEDGE_DIR, f)
                  for f in os.listdir(KNOWLEDGE_DIR) if f.endswith(".md")]
    return _tfidf_search(query, files, top_k=top_k)


async def expand_query(query: str) -> List[str]:
    """Expand query with synonyms/related terms for better BM25 recall."""
    # Generate 2-3 alternative search terms using simple heuristics
    expansions = [query]
    # Split into words, add individual significant words (>3 chars) as separate searches
    words = [w for w in query.split() if len(w) > 3]
    if len(words) > 1:
        expansions.append(" ".join(words[:3]))  # first 3 significant words
    # Transliteration-aware: if query has cyrillic, keep as-is
    # Add common abbreviations
    abbrevs = {"api": "API интерфейс", "бд": "база данных database", "мсп": "MCP"}
    for w in words:
        if w.lower() in abbrevs:
            expansions.append(abbrevs[w.lower()])
    return expansions[:3]  # max 3 query variants

@mcp.tool()
async def search_memory(query: str, tier: str = "all", top_k: int = 3) -> str:
    """
    Search OpenClaw memory tiers using hybrid BM25 (ripgrep) + Vector Search + LLM Re-ranking.
    :param query: Search query or keyword.
    :param tier: 'hot', 'domain', 'cold', 'knowledge' (static API/framework refs), or 'all'.
    :param top_k: Number of semantic results to return.
    """
    # Collect knowledge/ static reference files
    knowledge_files = []
    if os.path.isdir(KNOWLEDGE_DIR):
        knowledge_files = [
            os.path.join(KNOWLEDGE_DIR, f)
            for f in os.listdir(KNOWLEDGE_DIR)
            if f.endswith(".md")
        ]

    files_to_search = []
    if tier == "hot":
        files_to_search = [HOT_MEMORY]
    elif tier == "domain":
        files_to_search = [DOMAIN_EXPERTS]
    elif tier == "cold":
        files_to_search = [COLD_MEMORY]
    elif tier == "knowledge":
        files_to_search = knowledge_files
    else:  # all
        files_to_search = [HOT_MEMORY, DOMAIN_EXPERTS, COLD_MEMORY] + knowledge_files

    # 1. Keyword Search via ripgrep with query expansion (BM25 proxy)
    expanded_queries = await expand_query(query)
    rg_matches = []
    for file_path in files_to_search:
        if not os.path.exists(file_path):
            continue
        for q in expanded_queries:
            try:
                result = subprocess.run(
                    ["rg", "-i", "-C", "2", "--no-heading", q, file_path],
                    capture_output=True, text=True, timeout=5
                )
                if result.stdout:
                    rg_matches.append(result.stdout)
            except Exception as e:
                print(f"Error searching {file_path}: {e}", file=sys.stderr)

    # 2. Vector Search (Semantic)
    v_matches = await vector_search(query, tier, top_k=top_k*2)
    
    # 3. Combine and Re-rank
    all_snippets = list(set(rg_matches + v_matches))
    if not all_snippets:
        return "[RAG_CONFIDENCE: NONE] No relevant information found in memory tiers. Ответ без подтверждения из памяти."

    # Compute average similarity for confidence tagging
    avg_sim = 0.0
    if v_matches:
        # Re-compute similarities for confidence assessment
        query_vec = await get_embeddings(query)
        if query_vec and os.path.exists(INDEX_FILE):
            try:
                with open(INDEX_FILE, "r", encoding="utf-8") as f:
                    index = json.load(f)
                sims = []
                for snippet_id, data in index.items():
                    sim = cosine_similarity(query_vec, data.get("vector", []))
                    if sim > 0.4:
                        sims.append(sim)
                if sims:
                    avg_sim = sum(sims[:top_k]) / len(sims[:top_k])
            except Exception:
                pass

    confidence_tag = "HIGH" if avg_sim > 0.7 else ("MEDIUM" if avg_sim > 0.5 else "LOW")

    joined_matches = "\n---\n".join(all_snippets[:8]) # Limit for context window
    
    prompt = (
        "You are a Memory Re-ranker. Select the most relevant snippets from the memory bank to answer the user query.\n"
        f"USER QUERY: {query}\n\n"
        f"SNIPPETS:\n{joined_matches}\n\n"
        f"TASK: Select the top {top_k} most relevant snippets. Return them exactly, separated by '---'."
    )

    # Use Unified LLM Gateway for re-ranking (respects cloud-only mode)
    try:
        result = await route_llm(
            prompt,
            task_type="general",
            max_tokens=256,
            temperature=0.0,
        )
        if result:
            return f"[RAG_CONFIDENCE: {confidence_tag}] {result}"
        else:
            return f"[RAG_CONFIDENCE: LOW] Re-ranking unavailable. Raw match snippet:\n{joined_matches[:500]}"
    except Exception as e:
        return f"[RAG_CONFIDENCE: LOW] Hybrid search failed: {e}. Raw match snippet:\n{joined_matches[:500]}"

@mcp.tool()
async def run_extension(extension_name: str, command: str, args: Optional[List[str]] = None) -> str:
    """
    Run an OpenClaw extension via unified CLI interface.
    :param extension_name: Name of the extension (e.g., 'whatsapp', 'telegram').
    :param command: Command to execute (e.g., 'send', 'status').
    :param args: Optional arguments list.
    """
    full_cmd = ["pnpm", "openclaw", "extensions", extension_name, command]
    if args:
        full_cmd.extend(args)
    
    try:
        # Run in the repository root
        result = subprocess.run(
            full_cmd,
            capture_output=True, text=True, timeout=30,
            cwd=os.getcwd()
        )
        if result.returncode == 0:
            return result.stdout if result.stdout else "Extension command executed successfully."
        else:
            return f"Extension error (Exit {result.returncode}): {result.stderr}"
    except Exception as e:
        return f"Failed to run extension {extension_name}: {e}"

def export_vault_content() -> str:
    """Collects all .md files in the .obsidian vault (filtered by tags) and generates a Mega-source."""
    obsidian_dir = os.path.join(_project_root, ".obsidian")
    if not os.path.exists(obsidian_dir):
        return "Obsidian vault not found."

    mega_source = []
    toc = []
    
    # Recursively scan .obsidian for .md files
    for root, _, files in os.walk(obsidian_dir):
        for f in files:
            if f.endswith(".md"):
                if f == "Obsidian_Brain_Dump.md": continue
                fpath = os.path.join(root, f)
                try:
                    with open(fpath, "r", encoding="utf-8") as file_obj:
                        content = file_obj.read()
                        
                        # v16.2 Filtering
                        if "#v16_knowledge" in content or "#golden_snippet" in content:
                            anchor = f.replace(" ", "-").replace(".", "").lower()
                            toc.append(f"- [{f}](#document-{anchor})")
                            mega_source.append(f"## Document: {f}\n\n{content.strip()}\n")
                except Exception:
                    pass

    if not mega_source:
        return "No markdown files found in Obsidian vault with #v16_knowledge or #golden_snippet."

    final_content = "# Obsidian Brain Dump\n\n## Table of Contents\n" + "\n".join(toc) + "\n\n---\n\n" + "\n\n---\n\n".join(mega_source)
    
    # Write the dump locally
    try:
        dump_path = os.path.join(obsidian_dir, "Obsidian_Brain_Dump.md")
        with open(dump_path, "w", encoding="utf-8") as df:
            df.write(final_content)
    except Exception:
        pass

    return final_content

@mcp.tool()
async def export_vault_for_notebooklm() -> str:
    """
    Simulate NotebookLM Context Bridge. 
    Collects all .md files in the .obsidian vault and concatenates them into a single Mega-source.
    Returns the concatenated content, stripped of heavy tags.
    """
    return export_vault_content()


# ---------------------------------------------------------------------------
# v16.6  Codebase Mega-Dump Generator
# ---------------------------------------------------------------------------

_LANG_MAP = {
    ".py": "python", ".rs": "rust", ".ts": "typescript", ".js": "javascript",
    ".toml": "toml", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".md": "markdown", ".sh": "bash", ".ps1": "powershell", ".sql": "sql",
    ".html": "html", ".css": "css", ".mjs": "javascript",
}

_IGNORE_DIRS = {
    ".venv", "__pycache__", ".git", ".pytest_cache", ".obsidian",
    "node_modules", ".mypy_cache", ".ruff_cache", "target",
    "unsloth_compiled_cache", "dist", ".tox",
}

_IGNORE_EXTS = {
    ".pyc", ".pyo", ".so", ".pyd", ".dll", ".exe", ".whl",
    ".egg-info", ".tar", ".gz", ".zip", ".png", ".jpg", ".jpeg",
    ".gif", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".lock",
}

_IGNORE_FILES = {".env", ".env.local", ".env.production", "pnpm-lock.yaml"}


def export_openclaw_codebase() -> str:
    """Recursively export src/, scripts/ and root config files into a single Markdown file."""
    scan_dirs = [
        os.path.join(_project_root, "src"),
        os.path.join(_project_root, "scripts"),
    ]
    root_globs = {".toml", ".json", ".md", ".mjs"}
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


@mcp.tool()
async def export_codebase_for_notebooklm() -> str:
    """Export the entire OpenClaw source code into a single Markdown for NotebookLM."""
    return export_openclaw_codebase()


# ---------------------------------------------------------------------------
# v16.7 — Compact bot-only dump (Python sources only, NotebookLM-compatible)
# Limit: 500 000 words per NotebookLM source. Full dump (4 400+ files) is 5x
# over. This export includes ONLY Python files from src/ and src/pipeline/,
# plus key root docs — keeping the output safely below ~150 000 words.
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
      • Root docs/configs listed in _BOT_ROOT_DOCS
      • src/*.py          — all top-level Python modules
      • src/pipeline/*.py — pipeline engine modules
      • tests/*.py        — unit test suite

    Output: OpenClaw_Bot_Dump.md at project root (~100–200 KB, <200 000 words).
    """
    py_scan_dirs = [
        os.path.join(_project_root, "src"),      # top-level .py only (depth=0)
        os.path.join(_project_root, "src", "pipeline"),
        os.path.join(_project_root, "tests"),
    ]

    toc: list[str] = []
    sections: list[str] = []
    file_count = 0
    total_bytes = 0

    def _anchor(rel: str) -> str:
        return (rel.replace("/", "-").replace("\\", "-")
                   .replace(".", "-").replace("_", "-").lower())

    def _add_file(abs_path: str, rel_path: str) -> None:
        nonlocal file_count, total_bytes
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception:
            return
        rel_unix = rel_path.replace("\\", "/")
        anchor = _anchor(rel_unix)
        _, ext = os.path.splitext(rel_unix)
        lang = _LANG_MAP.get(ext, "")
        toc.append(f"- [{rel_unix}](#{anchor})")
        sections.append(f"## File: {rel_unix}\n\n```{lang}\n{content.rstrip()}\n```")
        file_count += 1
        total_bytes += len(content)

    # 1. Root docs/configs
    for name in sorted(os.listdir(_project_root)):
        full = os.path.join(_project_root, name)
        if os.path.isfile(full) and name in _BOT_ROOT_DOCS:
            _add_file(full, name)

    # 2. Python files — top-level src/ only (no recursion into TypeScript subdirs)
    src_dir = os.path.join(_project_root, "src")
    if os.path.isdir(src_dir):
        for fname in sorted(os.listdir(src_dir)):
            if fname.endswith(".py") and not fname.startswith("__"):
                _add_file(os.path.join(src_dir, fname), os.path.join("src", fname))

    # 3. src/pipeline/*.py
    pipeline_dir = os.path.join(_project_root, "src", "pipeline")
    if os.path.isdir(pipeline_dir):
        for fname in sorted(os.listdir(pipeline_dir)):
            if fname.endswith(".py"):
                rel = os.path.join("src", "pipeline", fname)
                _add_file(os.path.join(pipeline_dir, fname), rel)

    # 4. tests/*.py
    tests_dir = os.path.join(_project_root, "tests")
    if os.path.isdir(tests_dir):
        for fname in sorted(os.listdir(tests_dir)):
            if fname.endswith(".py"):
                rel = os.path.join("tests", fname)
                _add_file(os.path.join(tests_dir, fname), rel)

    if not sections:
        return "No source files found."

    header = (
        "# OpenClaw Bot — Python Source Dump\n\n"
        "> Auto-generated · NotebookLM-compatible · "
        f"{file_count} files · {total_bytes:,} bytes\n\n"
        "## Table of Contents\n\n"
    )
    body = header + "\n".join(toc) + "\n\n---\n\n" + "\n\n---\n\n".join(sections) + "\n"

    dump_path = os.path.join(_project_root, "OpenClaw_Bot_Dump.md")
    with open(dump_path, "w", encoding="utf-8") as f:
        f.write(body)

    return body


@mcp.tool()
async def export_bot_for_notebooklm() -> str:
    """Export Python bot sources (compact, <200 000 words) for NotebookLM upload."""
    return export_bot_codebase_compact()


if __name__ == "__main__":
    mcp.run()
