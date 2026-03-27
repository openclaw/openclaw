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

import aiohttp
from mcp.server.fastmcp import FastMCP

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
                print(f"Error searching {file_path}: {e}")

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

if __name__ == "__main__":
    mcp.run()
