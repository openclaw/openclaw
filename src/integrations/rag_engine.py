"""
RAG Engine — ChromaDB-based Retrieval-Augmented Generation for OpenClaw.

Indexes documentation, memory-bank files, and agent definitions.
Provides query() for pipeline context injection.

Zero-VRAM: uses sentence-transformers (CPU) or falls back to
ChromaDB's built-in default embedding function.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger("RAGEngine")

# ---------------------------------------------------------------------------
# Chunking helpers
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^#{1,4}\s+", re.MULTILINE)
_MAX_CHUNK_CHARS = 1200  # ~300 tokens per chunk
_OVERLAP_CHARS = 200


def _split_markdown(text: str, max_chars: int = _MAX_CHUNK_CHARS) -> List[str]:
    """Split markdown text into overlapping chunks at heading boundaries."""
    sections = _HEADING_RE.split(text)
    chunks: List[str] = []
    current = ""

    for section in sections:
        section = section.strip()
        if not section:
            continue
        if len(current) + len(section) <= max_chars:
            current = f"{current}\n\n{section}" if current else section
        else:
            if current:
                chunks.append(current.strip())
            # If single section exceeds max — split by paragraphs
            if len(section) > max_chars:
                paragraphs = section.split("\n\n")
                sub = ""
                for para in paragraphs:
                    if len(sub) + len(para) <= max_chars:
                        sub = f"{sub}\n\n{para}" if sub else para
                    else:
                        if sub:
                            chunks.append(sub.strip())
                        sub = para
                if sub:
                    chunks.append(sub.strip())
                current = ""
            else:
                current = section

    if current.strip():
        chunks.append(current.strip())

    # Add overlap between chunks for context continuity
    if len(chunks) > 1 and _OVERLAP_CHARS > 0:
        overlapped: List[str] = [chunks[0]]
        for i in range(1, len(chunks)):
            prev_tail = chunks[i - 1][-_OVERLAP_CHARS:]
            overlapped.append(f"...{prev_tail}\n\n{chunks[i]}")
        chunks = overlapped

    return chunks


def _file_hash(content: str) -> str:
    """MD5 hash of content for change detection."""
    return hashlib.md5(content.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# RAG Engine
# ---------------------------------------------------------------------------

class RAGEngine:
    """ChromaDB-backed retrieval engine for documentation and memory.

    Features:
    - Auto-indexes .md files from configured directories
    - Change detection via content hashing (skips unchanged files)
    - Query returns top-k relevant chunks with metadata
    - Integrates with TieredMemoryManager (promotes RAG hits to hot memory)
    """

    def __init__(
        self,
        persist_dir: str = "data/rag_db",
        collection_name: str = "openclaw_docs",
        index_dirs: Optional[List[str]] = None,
    ):
        self._persist_dir = persist_dir
        self._collection_name = collection_name
        self._index_dirs = index_dirs or []
        self._collection = None
        self._client = None
        self._file_hashes: Dict[str, str] = {}
        self._initialized = False

    def initialize(self) -> None:
        """Initialize ChromaDB client and collection."""
        try:
            import chromadb
            from chromadb.config import Settings

            os.makedirs(self._persist_dir, exist_ok=True)
            self._client = chromadb.PersistentClient(
                path=self._persist_dir,
                settings=Settings(anonymized_telemetry=False),
            )
            self._collection = self._client.get_or_create_collection(
                name=self._collection_name,
                metadata={"hnsw:space": "cosine"},
            )
            self._initialized = True
            logger.info(
                "RAG engine initialized",
                persist_dir=self._persist_dir,
                collection=self._collection_name,
                existing_docs=self._collection.count(),
            )
        except ImportError:
            logger.warning(
                "ChromaDB not installed — RAG engine disabled. "
                "Install with: pip install chromadb"
            )
            self._initialized = False
        except Exception as e:
            logger.error("RAG engine initialization failed", error=str(e))
            self._initialized = False

    @property
    def is_ready(self) -> bool:
        return self._initialized and self._collection is not None

    # ------------------------------------------------------------------
    # Indexing
    # ------------------------------------------------------------------

    def index_directories(self, dirs: Optional[List[str]] = None) -> Dict[str, int]:
        """Index all .md files from given directories.

        Returns:
            Dict with counts: {"indexed": N, "skipped": M, "errors": E}
        """
        if not self.is_ready:
            return {"indexed": 0, "skipped": 0, "errors": 0}

        target_dirs = dirs or self._index_dirs
        stats = {"indexed": 0, "skipped": 0, "errors": 0}

        for dir_path in target_dirs:
            dir_path = os.path.abspath(dir_path)
            if not os.path.isdir(dir_path):
                logger.debug("RAG index dir not found, skipping", dir=dir_path)
                continue

            for root, _dirs, files in os.walk(dir_path):
                # Skip hidden dirs and node_modules
                parts = Path(root).parts
                if any(p.startswith(".") or p == "node_modules" for p in parts):
                    continue

                for fname in files:
                    if not fname.endswith(".md"):
                        continue
                    fpath = os.path.join(root, fname)
                    result = self._index_file(fpath, dir_path)
                    if result == "indexed":
                        stats["indexed"] += 1
                    elif result == "skipped":
                        stats["skipped"] += 1
                    else:
                        stats["errors"] += 1

        logger.info("RAG indexing complete", **stats)
        return stats

    def _index_file(self, fpath: str, base_dir: str) -> str:
        """Index a single file. Returns 'indexed', 'skipped', or 'error'."""
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()

            if len(content.strip()) < 50:
                return "skipped"

            content_hash = _file_hash(content)
            rel_path = os.path.relpath(fpath, base_dir)

            # Check if already indexed with same hash
            if self._file_hashes.get(rel_path) == content_hash:
                return "skipped"

            # Remove old chunks for this file
            existing = self._collection.get(
                where={"source_file": rel_path},
            )
            if existing and existing["ids"]:
                self._collection.delete(ids=existing["ids"])

            # Chunk and index
            chunks = _split_markdown(content)
            if not chunks:
                return "skipped"

            ids = []
            documents = []
            metadatas = []

            for i, chunk in enumerate(chunks):
                chunk_id = f"{rel_path}::chunk_{i}::{content_hash[:8]}"
                ids.append(chunk_id)
                documents.append(chunk)
                metadatas.append({
                    "source_file": rel_path,
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "content_hash": content_hash,
                    "indexed_at": time.time(),
                })

            self._collection.upsert(
                ids=ids,
                documents=documents,
                metadatas=metadatas,
            )
            self._file_hashes[rel_path] = content_hash
            return "indexed"

        except Exception as e:
            logger.warning("RAG index error", file=fpath, error=str(e))
            return "error"

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query(
        self,
        text: str,
        top_k: int = 5,
        min_relevance: float = 0.3,
    ) -> List[Dict[str, Any]]:
        """Query the RAG index for relevant chunks.

        Args:
            text: Query text
            top_k: Maximum number of results
            min_relevance: Minimum relevance score (0..1, cosine similarity)

        Returns:
            List of dicts: [{"content": str, "source": str, "score": float}]
        """
        if not self.is_ready or not text.strip():
            return []

        try:
            results = self._collection.query(
                query_texts=[text],
                n_results=min(top_k, 20),
            )

            if not results or not results["documents"]:
                return []

            output: List[Dict[str, Any]] = []
            docs = results["documents"][0]
            metas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(docs)
            distances = results["distances"][0] if results.get("distances") else [1.0] * len(docs)

            for doc, meta, dist in zip(docs, metas, distances):
                # ChromaDB returns distances (lower = better for cosine)
                # Convert to similarity: sim = 1 - distance (for cosine space)
                score = max(0.0, 1.0 - dist)
                if score < min_relevance:
                    continue
                output.append({
                    "content": doc,
                    "source": meta.get("source_file", "unknown"),
                    "chunk_index": meta.get("chunk_index", 0),
                    "score": round(score, 3),
                })

            return output

        except Exception as e:
            logger.warning("RAG query error", error=str(e))
            return []

    def format_context(self, results: List[Dict[str, Any]], max_chars: int = 3000) -> str:
        """Format RAG results into a context string for LLM prompts."""
        if not results:
            return ""

        parts: List[str] = []
        budget = max_chars

        for r in results:
            entry = f"[{r['source']}] (relevance: {r['score']:.0%})\n{r['content']}"
            if len(entry) > budget:
                break
            parts.append(entry)
            budget -= len(entry)

        return "\n\n---\n\n".join(parts)

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    def get_stats(self) -> Dict[str, Any]:
        """Return index statistics."""
        if not self.is_ready:
            return {"status": "disabled", "documents": 0}
        return {
            "status": "ready",
            "documents": self._collection.count(),
            "indexed_files": len(self._file_hashes),
            "persist_dir": self._persist_dir,
        }
