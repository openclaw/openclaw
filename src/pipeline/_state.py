"""Pipeline state management — SuperMemory, RAG, SmartModelRouter, Graph-RAG initialization."""

import os
import re
from typing import Any, Dict, List, Optional

import structlog

from src.ai.inference.router import SmartModelRouter
from src.ai.inference._shared import ModelProfile
from src.memory.graph_engine import DependencyGraphEngine
from src.memory.knowledge_store import KnowledgeStore

logger = structlog.get_logger(__name__)


def init_smart_router(config: Dict[str, Any], force_cloud: bool) -> Optional[SmartModelRouter]:
    """Initialize SmartModelRouter from config model profiles.

    Reuses the shared instance from llm_gateway if already configured.
    """
    from src.llm_gateway import _smart_router as shared_router

    if shared_router is not None:
        logger.info("SmartModelRouter: reusing shared instance from LLMGateway")
        return shared_router

    router_cfg = config.get("system", {}).get("model_router", {})
    if not router_cfg:
        return None

    profiles: Dict[str, ModelProfile] = {}
    for task_type, model_name in router_cfg.items():
        if force_cloud and any(tag in model_name.upper() for tag in ("AWQ", "GPTQ", "GGUF")):
            continue
        if model_name not in profiles:
            caps = [task_type]
            is_fast = "7b" in model_name.lower() or "mini" in model_name.lower()
            profiles[model_name] = ModelProfile(
                name=model_name,
                vram_gb=4.0 if is_fast else 9.5,
                capabilities=caps,
                speed_tier="fast" if is_fast else "medium",
                quality_tier="medium" if is_fast else "high",
            )
        else:
            profiles[model_name].capabilities.append(task_type)

    if profiles:
        logger.info("SmartModelRouter initialized", models=list(profiles.keys()))
        return SmartModelRouter(profiles)
    return None


def init_supermemory(executor) -> None:
    """Lazy-initialize SuperMemory + RAG Engine on the executor instance."""
    if executor._supermemory is not None:
        return

    try:
        from src.supermemory import SuperMemory

        mem_dir = os.path.join(executor._framework_root, "data", "supermemory")
        index_dirs = [
            os.path.join(executor._framework_root, "docs"),
            os.path.join(executor._framework_root, ".memory-bank"),
        ]
        executor._supermemory = SuperMemory(persist_dir=mem_dir, index_dirs=index_dirs)
        executor._supermemory.initialize()
        executor._supermemory.index_documents(index_dirs)
        logger.info("SuperMemory initialized and indexed")
    except Exception as e:
        logger.warning("SuperMemory init failed (non-fatal)", error=str(e))
        executor._supermemory = None

    try:
        from src.rag_engine import RAGEngine

        rag_dir = os.path.join(executor._framework_root, "data", "rag_db")
        executor._rag_engine = RAGEngine(
            persist_dir=rag_dir,
            index_dirs=[
                os.path.join(executor._framework_root, "docs"),
                os.path.join(executor._framework_root, ".memory-bank"),
            ],
        )
        executor._rag_engine.initialize()
        executor._rag_engine.index_directories()
        logger.info("RAGEngine initialized and indexed")
    except Exception as e:
        logger.warning("RAGEngine init failed (non-fatal)", error=str(e))
        executor._rag_engine = None

    # v11.7: Graph-RAG dependency engine
    try:
        executor._graph_engine = DependencyGraphEngine(project_root=executor._framework_root)
        executor._graph_engine.build()
        stats = executor._graph_engine.stats()
        logger.info("Graph-RAG engine initialized", files=stats.total_files, edges=stats.total_edges)
    except Exception as e:
        logger.warning("Graph-RAG init failed (non-fatal)", error=str(e))
        executor._graph_engine = None


async def recall_memory_context(executor, prompt: str) -> str:
    """Auto memory recall at pipeline start.

    Gathers relevant context from SuperMemory, RAG engine, and MCP memory_search.
    Returns a context string to seed the pipeline, or empty string on failure.
    """
    fragments: list[str] = []

    if executor._supermemory:
        try:
            results = executor._supermemory.recall(prompt, top_k=3)
            for r in results:
                fragments.append(f"[Memory/{r.source}] {r.content[:400]}")
        except Exception as e:
            logger.debug("SuperMemory recall failed", error=str(e))

    if executor._rag_engine:
        try:
            rag_results = executor._rag_engine.query(prompt, top_k=3, min_relevance=0.25)
            for doc in rag_results:
                fragments.append(f"[RAG] {doc.get('content', '')[:400]}")
        except Exception as e:
            logger.debug("RAG query failed", error=str(e))

    if executor.openclaw_mcp:
        try:
            mcp_result = await executor.openclaw_mcp.call_tool("memory_search", {"query": prompt})
            if mcp_result and isinstance(mcp_result, str) and len(mcp_result.strip()) > 5:
                fragments.append(f"[MCP Memory] {mcp_result[:600]}")
        except Exception as e:
            logger.debug("MCP memory_search failed", error=str(e))

    # v11.7: Graph-RAG — enrich context with dependency info for mentioned files
    if getattr(executor, "_graph_engine", None):
        try:
            # Extract file paths from the prompt
            file_refs = re.findall(r'[\w/\\]+\.(?:py|ts|rs|js)', prompt)
            for fref in file_refs[:3]:  # limit to 3 files
                graph_ctx = executor._graph_engine.get_context_for_rag(fref, depth=2)
                if graph_ctx:
                    fragments.append(f"[Graph-RAG/{fref}] {graph_ctx[:400]}")
        except Exception as e:
            logger.debug("Graph-RAG context failed", error=str(e))

    # v12.1: Knowledge-First — auto-inject modern standards from KnowledgeStore
    try:
        _knowledge_keywords = {
            "async": ["STANDARD_LIBRARY_PY314", "RUST_STABLE_2026"],
            "concurrent": ["STANDARD_LIBRARY_PY314"],
            "interpreters": ["STANDARD_LIBRARY_PY314"],
            "type": ["STANDARD_LIBRARY_PY314", "TYPESCRIPT_MODERN_58"],
            "annotation": ["STANDARD_LIBRARY_PY314"],
            "template": ["STANDARD_LIBRARY_PY314", "TYPESCRIPT_MODERN_58"],
            "t-string": ["STANDARD_LIBRARY_PY314"],
            "enum": ["TYPESCRIPT_MODERN_58", "RUST_STABLE_2026"],
            "import": ["TYPESCRIPT_MODERN_58"],
            "iterator": ["TYPESCRIPT_MODERN_58", "RUST_STABLE_2026"],
            "unsafe": ["RUST_STABLE_2026"],
            "extern": ["RUST_STABLE_2026"],
            "match": ["RUST_STABLE_2026"],
            "lifetime": ["RUST_STABLE_2026"],
            "impl trait": ["RUST_STABLE_2026"],
            "typescript": ["TYPESCRIPT_MODERN_58"],
            "noinfer": ["TYPESCRIPT_MODERN_58"],
            "set": ["TYPESCRIPT_MODERN_58"],
            "groupby": ["TYPESCRIPT_MODERN_58"],
            "python": ["STANDARD_LIBRARY_PY314"],
            "rust": ["RUST_STABLE_2026"],
            "код": ["STANDARD_LIBRARY_PY314", "RUST_STABLE_2026", "TYPESCRIPT_MODERN_58"],
            "напиши": ["STANDARD_LIBRARY_PY314", "RUST_STABLE_2026", "TYPESCRIPT_MODERN_58"],
            "рефактор": ["STANDARD_LIBRARY_PY314", "RUST_STABLE_2026", "TYPESCRIPT_MODERN_58"],
        }
        prompt_lower = prompt.lower()
        matched_tags: set[str] = set()
        for kw, tags in _knowledge_keywords.items():
            if kw in prompt_lower:
                matched_tags.update(tags)

        if matched_tags:
            framework_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
            ks = KnowledgeStore(project_root=framework_root)
            ks.build()
            knowledge_ctx = ks.get_context_for_prompt(list(matched_tags), max_entries=8)
            if knowledge_ctx:
                fragments.append(f"[KnowledgeStore v12.1] {knowledge_ctx[:1200]}")
                logger.info("Knowledge-First recall injected", tags=list(matched_tags))
    except Exception as e:
        logger.debug("Knowledge-First recall failed", error=str(e))

    if not fragments:
        return ""

    header = "[AUTO-RECALLED CONTEXT — relevant memories and documents]\n"
    return header + "\n".join(fragments) + "\n"
