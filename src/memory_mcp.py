import asyncio
import json
import os
import subprocess
from typing import Any, Dict, List, Optional

import aiohttp
from mcp.server.fastmcp import FastMCP

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
                cfg = json.load(f)
                return cfg.get("system", {}).get("vllm_base_url", "http://localhost:8000/v1")
    except:
        pass
    return "http://localhost:8000/v1"

VLLM_URL = os.environ.get("VLLM_BASE_URL", get_config_vllm_url()).rstrip("/")

RERANK_MODEL = "google/gemma-3-12b-it"
EMBED_MODEL = "nvidia/nv-embedqa-e5-v5"
INDEX_FILE = os.path.join(MEMORY_BANK_DIR, "embeddings.json")

async def get_embeddings(text: str) -> List[float]:
    """Get embeddings for a text snippet using vLLM local server."""
    try:
        async with aiohttp.ClientSession(trust_env=False) as session:
            async with session.post(f"{VLLM_URL}/embeddings", json={
                "model": EMBED_MODEL,
                "input": text,
                "input_type": "query"
            }, timeout=10, proxy=None) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("data", [{}])[0].get("embedding", [])
    except Exception as e:
        print(f"Embedding error: {e}")
    return []

def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    """Simple dot product (assuming normalized vectors from nomic-embed-text)."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    return sum(a * b for a, b in zip(v1, v2))

async def vector_search(query: str, tier: str, top_k: int = 5) -> List[str]:
    """Perform semantic search using cached embeddings."""
    query_vec = await get_embeddings(query)
    if not query_vec:
        return []

    if not os.path.exists(INDEX_FILE):
        return []

    try:
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            index = json.load(f)
    except:
        return []

    results = []
    for snippet_id, data in index.items():
        if tier != "all" and data.get("tier") != tier:
            continue
        sim = cosine_similarity(query_vec, data.get("vector", []))
        if sim > 0.4: # Similarity threshold
            results.append((sim, data.get("text", "")))
    
    results.sort(key=lambda x: x[0], reverse=True)
    return [text for sim, text in results[:top_k]]

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

    # 1. Keyword Search via ripgrep (The BM25 proxy)
    rg_matches = []
    for file_path in files_to_search:
        if not os.path.exists(file_path):
            continue
        try:
            result = subprocess.run(
                ["rg", "-i", "-C", "2", "--no-heading", query, file_path],
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

    joined_matches = "\n---\n".join(all_snippets[:15]) # Limit for context window
    
    prompt = (
        "You are a Memory Re-ranker. Select the most relevant snippets from the memory bank to answer the user query.\n"
        f"USER QUERY: {query}\n\n"
        f"SNIPPETS:\n{joined_matches}\n\n"
        f"TASK: Select the top {top_k} most relevant snippets. Return them exactly, separated by '---'."
    )

    rerank_payload = {
        "model": RERANK_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "max_tokens": 1024,
    }

    try:
        async with aiohttp.ClientSession(trust_env=False) as session:
            async with session.post(f"{VLLM_URL}/chat/completions", json=rerank_payload, timeout=30, proxy=None) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    result = data["choices"][0]["message"]["content"].strip()
                    return f"[RAG_CONFIDENCE: {confidence_tag}] {result}"
                else:
                    return f"[RAG_CONFIDENCE: LOW] Re-ranking failed. Raw match snippet:\n{joined_matches[:500]}"
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
