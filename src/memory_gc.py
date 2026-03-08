"""
Brigade: OpenClaw
Role: Memory GC (Anchored Iterative Context Compressor v2)
Model: gemma3:12b

Replaces naive one-shot summarization with anchored iterative compression:
- Maintains a persistent summary across invocations
- Merges new messages into the existing summary incrementally
- Estimates token count to trigger compression only when needed
- Preserves system prompts and critical context anchors
"""

import asyncio
import os
from typing import Dict, List, Optional

import aiohttp


# Rough token estimation: ~4 chars ≈ 1 token (works for English/Russian mix)
def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class MemoryGarbageCollector:
    """
    Anchored Iterative Context Compressor.

    Instead of summarizing the entire history from scratch each time,
    this compressor maintains a persistent summary and incrementally
    merges new messages into it. This preserves critical facts while
    drastically reducing token usage.
    """

    # Compression triggers
    TOKEN_THRESHOLD = 2400  # Trigger compression above this token count (doubled for CUDA 16GB)
    MIN_MESSAGES_TO_COMPRESS = 4  # Don't compress very short histories
    MAX_SUMMARY_TOKENS = 800  # Target size for compressed summary (expanded for gemma3:12b 128K ctx)

    def __init__(self, ollama_url: Optional[str] = None):
        self.ollama_url = ollama_url or os.environ.get("OLLAMA_URL", "http://localhost:11434")
        self.model = "gemma3:12b"
        self._persistent_summary: str = ""
        self._compression_count: int = 0

    @property
    def persistent_summary(self) -> str:
        return self._persistent_summary

    async def compress_if_needed(self, history: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """
        Main entry point. Checks if compression is needed and applies it.
        Returns the (possibly compressed) history.

        Logic:
        1. If history is short (< MIN_MESSAGES_TO_COMPRESS non-system msgs) → skip
        2. If estimated tokens < TOKEN_THRESHOLD → skip
        3. Otherwise → compress incrementally and return new history
        
        [QMD INTEGRATION]: Note that actual deep retrieval for the .memory-bank
        will use local hybrid vector search (QMD) instead of standard grep.
        """
        # Separate system prompts from conversation
        system_msgs = []
        conversation_msgs = []
        for msg in history:
            if msg.get("role") == "system" and not msg.get("content", "").startswith(
                "[CONTEXT BRIEFING]"
            ):
                system_msgs.append(msg)
            else:
                conversation_msgs.append(msg)

        # Check if compression is needed
        if len(conversation_msgs) < self.MIN_MESSAGES_TO_COMPRESS:
            return history

        total_text = "\n".join(m.get("content", "") for m in conversation_msgs)
        token_estimate = estimate_tokens(total_text)

        if token_estimate < self.TOKEN_THRESHOLD:
            return history

        # Perform anchored incremental compression
        new_summary = await self._anchored_merge(conversation_msgs)

        if new_summary and new_summary != "ERROR_SUMMARIZING_CONTEXT":
            self._persistent_summary = new_summary
            self._compression_count += 1
            return self.truncate_and_replace(history, new_summary)

        # On failure, return original history unchanged
        return history

    async def _anchored_merge(self, new_messages: List[Dict[str, str]]) -> str:
        """
        Core algorithm: Anchored Iterative Summarization.

        If a persistent summary exists, merge NEW messages into it.
        If no summary exists, create one from scratch.
        This preserves previously compressed facts while integrating new data.
        """
        new_text = "\n".join(f"{msg['role']}: {msg['content']}" for msg in new_messages)

        if self._persistent_summary:
            # INCREMENTAL MERGE: existing summary + new delta
            prompt = (
                "You are the Memory Garbage Collector for a multi-agent AI system. "
                "You have an EXISTING compressed summary and NEW conversation messages. "
                "Merge them into a single, updated Context Briefing.\n\n"
                "Rules:\n"
                "- Retain ALL technical facts, active tasks, and latest states from BOTH sources\n"
                "- Remove duplicate information\n"
                "- Remove pleasantries, filler, and metadata\n"
                "- Keep entity names, numbers, endpoints, and file paths EXACTLY as they are\n"
                "- Output must be under 300 words\n"
                "- Use bullet points for clarity\n\n"
                f"EXISTING SUMMARY:\n{self._persistent_summary}\n\n"
                f"NEW MESSAGES:\n{new_text}"
            )
        else:
            # INITIAL COMPRESSION: create summary from scratch
            prompt = (
                "You are the Memory Garbage Collector for a multi-agent AI system. "
                "Compress the following conversation into a strict Context Briefing.\n\n"
                "Rules:\n"
                "- Retain ONLY the most crucial technical facts, latest states, and active tasks\n"
                "- Remove pleasantries, filler, and metadata\n"
                "- Keep entity names, numbers, endpoints, and file paths EXACTLY as they are\n"
                "- Output must be under 200 words\n"
                "- Use bullet points for clarity\n\n"
                f"CONVERSATION:\n{new_text}"
            )

        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "keep_alive": "30s",
            "options": {"num_ctx": 4096},
        }

        async def _run_inference():
            async with aiohttp.ClientSession() as session:
                try:
                    async with session.post(
                        f"{self.ollama_url}/api/generate",
                        json=payload,
                        timeout=aiohttp.ClientTimeout(total=30),
                    ) as response:
                        if response.status == 200:
                            data = await response.json()
                            return data.get("response", "").strip()
                        else:
                            print(f"[Memory GC] API Error: {response.status}")
                            return "ERROR_SUMMARIZING_CONTEXT"
                except asyncio.TimeoutError:
                    print("[Memory GC] Timeout during compression")
                    return "ERROR_SUMMARIZING_CONTEXT"
                except Exception as e:
                    print(f"[Memory GC] Exception: {e}")
                    return "ERROR_SUMMARIZING_CONTEXT"

        from src.task_queue import model_queue

        return await model_queue.enqueue(self.model, _run_inference)

    def truncate_and_replace(
        self, history: List[Dict[str, str]], summary: str
    ) -> List[Dict[str, str]]:
        """
        Replaces the old history with the compressed summary.
        Anchors: system prompts are NEVER removed.
        """
        new_history = []

        # Preserve ALL initial system prompts (Constitution / SOUL laws)
        for msg in history:
            if msg.get("role") == "system" and not msg.get("content", "").startswith(
                "[CONTEXT BRIEFING]"
            ):
                new_history.append(msg)
            else:
                break

        # Inject the compressed context briefing
        new_history.append(
            {
                "role": "system",
                "content": (
                    f"[CONTEXT BRIEFING] (Compression #{self._compression_count})\n{summary}"
                ),
            }
        )
        return new_history

    async def summarize_history(self, history: List[Dict[str, str]]) -> str:
        """
        Legacy API compatibility. Returns a summary string.
        Prefer using compress_if_needed() for full pipeline.
        """
        conversation = [m for m in history if m.get("role") != "system"]
        return await self._anchored_merge(conversation)

    def get_stats(self) -> Dict[str, int]:
        """Returns compression statistics for monitoring."""
        return {
            "compression_count": self._compression_count,
            "persistent_summary_tokens": estimate_tokens(self._persistent_summary),
        }
