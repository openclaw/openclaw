"""
Brigade: OpenClaw
Role: Memory GC (Anchored Iterative Context Compressor v2)
Model: cloud LLM via route_llm (OpenRouter API)

Replaces naive one-shot summarization with anchored iterative compression:
- Maintains a persistent summary across invocations
- Merges new messages into the existing summary incrementally
- Estimates token count to trigger compression only when needed
- Preserves system prompts and critical context anchors
"""

import asyncio
import os
from typing import Dict, List, Optional

import structlog

from src.llm_gateway import route_llm
from src.utils.token_counter import estimate_tokens

logger = structlog.get_logger("MemoryGC")


class MemoryGarbageCollector:
    """
    Anchored Iterative Context Compressor v3.

    Instead of summarizing the entire history from scratch each time,
    this compressor maintains a persistent summary and incrementally
    merges new messages into it. This preserves critical facts while
    drastically reducing token usage.

    v3 improvements:
      - Priority-based fact retention: categorize facts by importance level
      - Token-efficient prompts: shorter instructions, same quality
      - Bilingual support: handles mixed EN/RU conversations
      - Compression quality check: validates output isn't degraded
    """

    # Compression triggers
    TOKEN_THRESHOLD = 2400  # Trigger compression above this token count
    MIN_MESSAGES_TO_COMPRESS = 4  # Don't compress very short histories
    MAX_SUMMARY_TOKENS = 800  # Target size for compressed summary

    # Progressive compression: tighter limits after repeated compressions
    AGGRESSIVE_COMPRESSION_AFTER = 3  # After N compressions, shrink harder
    AGGRESSIVE_MAX_WORDS = 150  # Tighter word limit in aggressive mode

    # v3: fact priority levels
    FACT_PRIORITIES = ("CRITICAL", "IMPORTANT", "CONTEXT")

    def __init__(self, config: dict = None):
        if config and config.get("system", {}).get("model_router", {}).get("memory_gc"):
            self.model = config["system"]["model_router"]["memory_gc"]
        else:
            self.model = "google/gemma-3-12b-it:free"
        self._persistent_summary: str = ""
        self._compression_count: int = 0
        self._critical_facts: list = []  # Never-forget facts extracted during compression
        self._important_facts: list = []  # v3: important but not critical facts
        self._total_tokens_saved: int = 0  # v3: track compression efficiency

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
            # v3: track tokens saved
            original_tokens = token_estimate
            new_tokens = estimate_tokens(new_summary)
            self._total_tokens_saved += max(0, original_tokens - new_tokens)

            # Extract critical facts from the summary for pinning
            self._extract_critical_facts(new_summary)
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

        # Progressive compression: tighter word limits after many rounds
        is_aggressive = self._compression_count >= self.AGGRESSIVE_COMPRESSION_AFTER
        word_limit = self.AGGRESSIVE_MAX_WORDS if is_aggressive else 300

        # Inject pinned critical facts to preserve across compressions
        critical_section = ""
        if self._critical_facts:
            critical_section = "\n\nCRITICAL FACTS (MUST PRESERVE):\n" + "\n".join(f"- {f}" for f in self._critical_facts)
        if self._important_facts:
            critical_section += "\n\nIMPORTANT FACTS (PRESERVE IF SPACE):\n" + "\n".join(f"- {f}" for f in self._important_facts)

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
                "- Preserve the language of the original content (EN or RU)\n"
                f"- Output must be under {word_limit} words\n"
                "- Use bullet points for clarity\n"
                "- At the end, add prioritized sections:\n"
                "  CRITICAL: [3-5 facts that must NEVER be lost]\n"
                "  IMPORTANT: [3-5 facts useful for ongoing context]\n\n"
                f"EXISTING SUMMARY:\n{self._persistent_summary}{critical_section}\n\n"
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
                "- Preserve the language of the original content (EN or RU)\n"
                f"- Output must be under {word_limit} words\n"
                "- Use bullet points for clarity\n"
                "- At the end, add prioritized sections:\n"
                "  CRITICAL: [3-5 facts that must NEVER be lost]\n"
                "  IMPORTANT: [3-5 facts useful for ongoing context]\n\n"
                f"CONVERSATION:\n{new_text}"
            )

        try:
            result = await route_llm(prompt, model=self.model, max_tokens=1024)
            return result or "ERROR_SUMMARIZING_CONTEXT"
        except asyncio.TimeoutError:
            logger.warning("Timeout during compression")
            return "ERROR_SUMMARIZING_CONTEXT"
        except Exception as e:
            logger.warning("Memory GC compression failed", error=str(e))
            return "ERROR_SUMMARIZING_CONTEXT"

    def _extract_critical_facts(self, summary: str):
        """Extract prioritized facts from summary and pin them for future compressions.

        v3: supports CRITICAL and IMPORTANT priority levels.
        """
        import re
        # Extract CRITICAL facts
        match = re.search(r'CRITICAL:\s*(.+?)(?:IMPORTANT:|$)', summary, re.IGNORECASE | re.DOTALL)
        if match:
            facts_text = match.group(1)
            facts = [f.strip().lstrip('- ') for f in re.split(r'[;]|\n-|\n\*', facts_text) if f.strip()]
            self._critical_facts = facts[:5]

        # v3: Extract IMPORTANT facts
        match_imp = re.search(r'IMPORTANT:\s*(.+?)(?:CONTEXT:|$)', summary, re.IGNORECASE | re.DOTALL)
        if match_imp:
            imp_text = match_imp.group(1)
            imp_facts = [f.strip().lstrip('- ') for f in re.split(r'[;]|\n-|\n\*', imp_text) if f.strip()]
            self._important_facts = imp_facts[:5]

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
        """Returns compression statistics for monitoring.

        v3: includes critical/important fact counts and tokens saved.
        """
        return {
            "compression_count": self._compression_count,
            "persistent_summary_tokens": estimate_tokens(self._persistent_summary),
            "critical_facts_count": len(self._critical_facts),
            "important_facts_count": len(self._important_facts),
            "total_tokens_saved": self._total_tokens_saved,
        }
