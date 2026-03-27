"""Pipeline state management — SuperMemory, RAG, SmartModelRouter initialization."""

import os
from typing import Any, Dict, Optional

import structlog

from src.ai.inference.router import SmartModelRouter
from src.ai.inference._shared import ModelProfile

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

    if not fragments:
        return ""

    header = "[AUTO-RECALLED CONTEXT — relevant memories and documents]\n"
    return header + "\n".join(fragments) + "\n"
