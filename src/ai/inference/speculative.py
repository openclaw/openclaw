"""Speculative decoding, chunked prefill, and prefix caching configs.

DEPRECATED (2025-07): These dataclass definitions are retained for reference only.
The bot is now cloud-only (OpenRouter API) — use ``route_llm`` from
``src.llm_gateway`` for all inference. vLLM CLI args and local inference
optimisations are no longer used.

References (historical):
- vLLM: Efficient Memory Management for LLM Serving (arXiv:2309.06180)
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SpeculativeDecodingConfig:
    """Configuration for speculative decoding (historical, unused in cloud mode)."""

    enabled: bool = False
    use_ngram: bool = True
    ngram_prompt_lookup_max: int = 8
    ngram_prompt_lookup_min: int = 1
    draft_model: str = "Qwen/Qwen2.5-0.5B-Instruct"
    num_speculative_tokens: int = 8

    def estimated_vram_overhead_gb(self) -> float:
        if not self.enabled:
            return 0.0
        return 0.0 if self.use_ngram else 1.0


@dataclass
class ChunkedPrefillConfig:
    """Chunked prefill config (historical, unused in cloud mode)."""

    enabled: bool = False
    max_num_batched_tokens: int = 4096


@dataclass
class PrefixCachingConfig:
    """Automatic KV-cache reuse config (historical, unused in cloud mode)."""

    enabled: bool = False
